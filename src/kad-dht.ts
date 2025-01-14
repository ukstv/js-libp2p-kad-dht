import { RoutingTable } from './routing-table/index.js'
import { RoutingTableRefresh } from './routing-table/refresh.js'
import { Network } from './network.js'
import { ContentFetching } from './content-fetching/index.js'
import { ContentRouting } from './content-routing/index.js'
import { PeerRouting } from './peer-routing/index.js'
import { Providers } from './providers.js'
import { QueryManager } from './query/manager.js'
import { RPC } from './rpc/index.js'
import { TopologyListener } from './topology-listener.js'
import { QuerySelf } from './query-self.js'
import {
  removePrivateAddresses,
  removePublicAddresses
} from './utils.js'
import { Logger, logger } from '@libp2p/logger'
import type { QueryOptions, Validators, Selectors, DHT } from '@libp2p/interfaces/dht'
import type { PeerInfo } from '@libp2p/interfaces/peer-info'
import { CustomEvent, EventEmitter } from '@libp2p/interfaces'
import type { PeerId } from '@libp2p/interfaces/peer-id'
import type { CID } from 'multiformats/cid'
import type { PeerDiscoveryEvents } from '@libp2p/interfaces/peer-discovery'
import { Components, Initializable } from '@libp2p/interfaces/components'
import type { KadDHTInit } from './index.js'
import { validators as recordValidators } from '@libp2p/record/validators'
import { selectors as recordSelectors } from '@libp2p/record/selectors'

/**
 * A DHT implementation modelled after Kademlia with S/Kademlia modifications.
 * Original implementation in go: https://github.com/libp2p/go-libp2p-kad-dht.
 */
export class KadDHT extends EventEmitter<PeerDiscoveryEvents> implements DHT, Initializable {
  public protocol: string
  public routingTable: RoutingTable
  public providers: Providers
  public network: Network
  public peerRouting: PeerRouting

  public components: Components = new Components()
  private readonly log: Logger
  private running: boolean
  private readonly kBucketSize: number
  private clientMode: boolean
  private readonly lan: boolean
  private readonly validators: Validators
  private readonly selectors: Selectors
  private readonly queryManager: QueryManager
  private readonly contentFetching: ContentFetching
  private readonly contentRouting: ContentRouting
  private readonly routingTableRefresh: RoutingTableRefresh
  private readonly rpc: RPC
  private readonly topologyListener: TopologyListener
  private readonly querySelf: QuerySelf

  /**
   * Create a new KadDHT
   */
  constructor (init: KadDHTInit) {
    super()

    const {
      kBucketSize,
      clientMode,
      validators,
      selectors,
      querySelfInterval,
      lan,
      protocolPrefix
    } = init

    this.running = false
    this.lan = Boolean(lan)
    this.log = logger(`libp2p:kad-dht:${lan === true ? 'lan' : 'wan'}`)
    this.protocol = `${protocolPrefix ?? '/ipfs'}${lan === true ? '/lan' : ''}/kad/1.0.0`
    this.kBucketSize = kBucketSize ?? 20
    this.clientMode = clientMode ?? true
    this.routingTable = new RoutingTable({
      kBucketSize,
      lan: this.lan
    })

    this.providers = new Providers()

    this.validators = {
      ...recordValidators,
      ...validators
    }
    this.selectors = {
      ...recordSelectors,
      ...selectors
    }
    this.network = new Network({
      protocol: this.protocol,
      lan: this.lan
    })
    this.queryManager = new QueryManager({
      // Number of disjoint query paths to use - This is set to `kBucketSize/2` per the S/Kademlia paper
      disjointPaths: Math.ceil(this.kBucketSize / 2),
      lan
    })

    // DHT components
    this.peerRouting = new PeerRouting({
      routingTable: this.routingTable,
      network: this.network,
      validators: this.validators,
      queryManager: this.queryManager,
      lan: this.lan
    })
    this.contentFetching = new ContentFetching({
      validators: this.validators,
      selectors: this.selectors,
      peerRouting: this.peerRouting,
      queryManager: this.queryManager,
      routingTable: this.routingTable,
      network: this.network,
      lan: this.lan
    })
    this.contentRouting = new ContentRouting({
      network: this.network,
      peerRouting: this.peerRouting,
      queryManager: this.queryManager,
      routingTable: this.routingTable,
      providers: this.providers,
      lan: this.lan
    })
    this.routingTableRefresh = new RoutingTableRefresh({
      peerRouting: this.peerRouting,
      routingTable: this.routingTable,
      lan: this.lan
    })
    this.rpc = new RPC({
      routingTable: this.routingTable,
      providers: this.providers,
      peerRouting: this.peerRouting,
      validators: this.validators,
      lan: this.lan
    })
    this.topologyListener = new TopologyListener({
      protocol: this.protocol,
      lan: this.lan
    })
    this.querySelf = new QuerySelf({
      peerRouting: this.peerRouting,
      interval: querySelfInterval,
      lan: this.lan
    })

    // handle peers being discovered during processing of DHT messages
    this.network.addEventListener('peer', (evt) => {
      const peerData = evt.detail

      this.onPeerConnect(peerData).catch(err => {
        this.log.error('could not add %p to routing table', peerData.id, err)
      })

      this.dispatchEvent(new CustomEvent('peer', {
        detail: peerData
      }))
    })

    // handle peers being discovered via other peer discovery mechanisms
    this.topologyListener.addEventListener('peer', (evt) => {
      const peerId = evt.detail

      Promise.resolve().then(async () => {
        const multiaddrs = await this.components.getPeerStore().addressBook.get(peerId)

        const peerData = {
          id: peerId,
          multiaddrs: multiaddrs.map(addr => addr.multiaddr),
          protocols: []
        }

        await this.onPeerConnect(peerData)
      }).catch(err => {
        this.log.error('could not add %p to routing table', peerId, err)
      })
    })
  }

  init (components: Components): void {
    this.components = components

    this.routingTable.init(components)
    this.providers.init(components)
    this.network.init(components)
    this.queryManager.init(components)
    this.peerRouting.init(components)
    this.contentFetching.init(components)
    this.contentRouting.init(components)
    this.routingTableRefresh.init(components)
    this.rpc.init(components)
    this.topologyListener.init(components)
    this.querySelf.init(components)
  }

  async onPeerConnect (peerData: PeerInfo) {
    this.log('peer %p connected with protocols %s', peerData.id, peerData.protocols)

    if (this.lan) {
      peerData = removePublicAddresses(peerData)
    } else {
      peerData = removePrivateAddresses(peerData)
    }

    if (peerData.multiaddrs.length === 0) {
      this.log('ignoring %p as they do not have any %s addresses in %s', peerData.id, this.lan ? 'private' : 'public', peerData.multiaddrs.map(addr => addr.toString()))
      return
    }

    try {
      await this.routingTable.add(peerData.id)
    } catch (err: any) {
      this.log.error('could not add %p to routing table', peerData.id, err)
    }
  }

  /**
   * Is this DHT running.
   */
  isStarted () {
    return this.running
  }

  /**
   * If 'server' this node will respond to DHT queries, if 'client' this node will not
   */
  async getMode () {
    return this.clientMode ? 'client' : 'server'
  }

  /**
   * If 'server' this node will respond to DHT queries, if 'client' this node will not
   */
  async setMode (mode: 'client' | 'server') {
    await this.components.getRegistrar().unhandle(this.protocol)

    if (mode === 'client') {
      this.log('enabling client mode')
      this.clientMode = true
    } else {
      this.log('enabling server mode')
      this.clientMode = false
      await this.components.getRegistrar().handle(this.protocol, this.rpc.onIncomingStream.bind(this.rpc))
    }
  }

  /**
   * Start listening to incoming connections.
   */
  async start () {
    this.running = true

    // Only respond to queries when not in client mode
    await this.setMode(this.clientMode ? 'client' : 'server')

    await Promise.all([
      this.providers.start(),
      this.queryManager.start(),
      this.network.start(),
      this.routingTable.start(),
      this.topologyListener.start(),
      this.querySelf.start()
    ])

    await this.routingTableRefresh.start()
  }

  /**
   * Stop accepting incoming connections and sending outgoing
   * messages.
   */
  async stop () {
    this.running = false

    await Promise.all([
      this.providers.stop(),
      this.queryManager.stop(),
      this.network.stop(),
      this.routingTable.stop(),
      this.routingTableRefresh.stop(),
      this.topologyListener.stop(),
      this.querySelf.stop()
    ])
  }

  /**
   * Store the given key/value pair in the DHT
   */
  async * put (key: Uint8Array, value: Uint8Array, options: QueryOptions = {}) { // eslint-disable-line require-await
    yield * this.contentFetching.put(key, value, options)
  }

  /**
   * Get the value that corresponds to the passed key
   */
  async * get (key: Uint8Array, options: QueryOptions = {}) { // eslint-disable-line require-await
    yield * this.contentFetching.get(key, options)
  }

  // ----------- Content Routing

  /**
   * Announce to the network that we can provide given key's value
   */
  async * provide (key: CID, options: QueryOptions = {}) { // eslint-disable-line require-await
    yield * this.contentRouting.provide(key, this.components.getAddressManager().getAddresses(), options)
  }

  /**
   * Search the dht for providers of the given CID
   */
  async * findProviders (key: CID, options: QueryOptions = {}) {
    yield * this.contentRouting.findProviders(key, options)
  }

  // ----------- Peer Routing -----------

  /**
   * Search for a peer with the given ID
   */
  async * findPeer (id: PeerId, options: QueryOptions = {}) { // eslint-disable-line require-await
    yield * this.peerRouting.findPeer(id, options)
  }

  /**
   * Kademlia 'node lookup' operation
   */
  async * getClosestPeers (key: Uint8Array, options: QueryOptions = {}) {
    yield * this.peerRouting.getClosestPeers(key, options)
  }

  async refreshRoutingTable () {
    await this.routingTableRefresh.refreshTable(true)
  }
}

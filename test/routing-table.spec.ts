/* eslint-env mocha */

import { expect } from 'aegir/chai'
import random from 'lodash.random'
import sinon from 'sinon'
import { RoutingTable } from '../src/routing-table/index.js'
import * as kadUtils from '../src/utils.js'
import { createPeerId, createPeerIds } from './utils/create-peer-id.js'
import { PROTOCOL_DHT } from '../src/constants.js'
import { peerIdFromString } from '@libp2p/peer-id'
import { Components } from '@libp2p/interfaces/components'
import { mockConnectionManager } from '@libp2p/interface-compliance-tests/mocks'

describe('Routing Table', () => {
  let table: RoutingTable
  let components: Components

  beforeEach(async function () {
    this.timeout(20 * 1000)

    components = new Components({
      peerId: await createPeerId(),
      connectionManager: mockConnectionManager()
    })

    table = new RoutingTable({
      lan: false
    })
    table.init(components)
    await table.start()
  })

  afterEach(async () => {
    await table.stop()
  })

  it('add', async function () {
    this.timeout(20 * 1000)

    const ids = await createPeerIds(20)

    await Promise.all(
      Array.from({ length: 1000 }).map(async () => await table.add(ids[random(ids.length - 1)]))
    )

    await Promise.all(
      Array.from({ length: 20 }).map(async () => {
        const id = ids[random(ids.length - 1)]
        const key = await kadUtils.convertPeerId(id)

        expect(table.closestPeers(key, 5).length)
          .to.be.above(0)
      })
    )
  })

  it('remove', async function () {
    this.timeout(20 * 1000)

    const peers = await createPeerIds(10)
    await Promise.all(peers.map(async (peer) => await table.add(peer)))

    const key = await kadUtils.convertPeerId(peers[2])
    expect(table.closestPeers(key, 10)).to.have.length(10)

    await table.remove(peers[5])
    expect(table.closestPeers(key, 10)).to.have.length(9)
    expect(table.size).to.be.eql(9)
  })

  it('closestPeer', async function () {
    this.timeout(10 * 1000)

    const peers = await createPeerIds(4)
    await Promise.all(peers.map(async (peer) => await table.add(peer)))

    const id = peers[2]
    const key = await kadUtils.convertPeerId(id)
    expect(table.closestPeer(key)).to.eql(id)
  })

  it('closestPeers', async function () {
    this.timeout(20 * 1000)

    const peers = await createPeerIds(18)
    await Promise.all(peers.map(async (peer) => await table.add(peer)))

    const key = await kadUtils.convertPeerId(peers[2])
    expect(table.closestPeers(key, 15)).to.have.length(15)
  })

  it('favours old peers that respond to pings', async () => {
    let fn: (() => Promise<any>) | undefined

    // execute queued functions immediately
    table.pingQueue = {
      // @ts-expect-error
      add: async (f: () => Promise<any>) => {
        fn = f
      },
      clear: () => {}
    }

    const peerIds = [
      peerIdFromString('QmYobx1VAHP7Mi88LcDvLeQoWcc1Aa2rynYHpdEPBqHZi5'),
      peerIdFromString('QmYobx1VAHP7Mi88LcDvLeQoWcc1Aa2rynYHpdEPBqHZi6')
    ]

    const oldPeer = {
      id: peerIds[0].toBytes(),
      peer: peerIds[0]
    }
    const newPeer = {
      id: peerIds[1].toBytes(),
      peer: peerIds[1]
    }

    table._onPing([oldPeer], newPeer)

    if (table.kb == null) {
      throw new Error('kbucket not defined')
    }

    // add the old peer
    table.kb.add(oldPeer)

    // simulate connection succeeding
    const newStreamStub = sinon.stub().withArgs(PROTOCOL_DHT).resolves({ stream: { close: sinon.stub() } })
    const openConnectionStub = sinon.stub().withArgs(oldPeer.peer).resolves({
      newStream: newStreamStub
    })
    components.getConnectionManager().openConnection = openConnectionStub

    if (fn == null) {
      throw new Error('nothing added to queue')
    }

    // perform the ping
    await fn()

    expect(openConnectionStub.calledOnce).to.be.true()
    expect(openConnectionStub.calledWith(oldPeer.peer)).to.be.true()

    expect(newStreamStub.callCount).to.equal(1)
    expect(newStreamStub.calledWith(PROTOCOL_DHT)).to.be.true()

    // did not add the new peer
    expect(table.kb.get(newPeer.id)).to.be.null()

    // kept the old peer
    expect(table.kb.get(oldPeer.id)).to.not.be.null()
  })

  it('evicts oldest peer that does not respond to ping', async () => {
    let fn: (() => Promise<any>) | undefined

    // execute queued functions immediately
    table.pingQueue = {
      // @ts-expect-error
      add: async (f: () => Promise<any>) => {
        fn = f
      },
      clear: () => {}
    }

    const peerIds = [
      peerIdFromString('QmYobx1VAHP7Mi88LcDvLeQoWcc1Aa2rynYHpdEPBqHZi5'),
      peerIdFromString('QmYobx1VAHP7Mi88LcDvLeQoWcc1Aa2rynYHpdEPBqHZi6')
    ]

    const oldPeer = {
      id: peerIds[0].toBytes(),
      peer: peerIds[0]
    }
    const newPeer = {
      id: peerIds[1].toBytes(),
      peer: peerIds[1]
    }

    table._onPing([oldPeer], newPeer)

    if (table.kb == null) {
      throw new Error('kbucket not defined')
    }

    // add the old peer
    table.kb.add(oldPeer)

    // libp2p fails to dial the old peer
    const openConnectionStub = sinon.stub().withArgs(oldPeer.peer).rejects(new Error('Could not dial peer'))
    components.getConnectionManager().openConnection = openConnectionStub

    if (fn == null) {
      throw new Error('nothing added to queue')
    }

    // perform the ping
    await fn()

    expect(openConnectionStub.callCount).to.equal(1)
    expect(openConnectionStub.calledWith(oldPeer.peer)).to.be.true()

    // added the new peer
    expect(table.kb.get(newPeer.id)).to.not.be.null()

    // evicted the old peer
    expect(table.kb.get(oldPeer.id)).to.be.null()
  })
})

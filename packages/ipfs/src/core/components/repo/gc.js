'use strict'

const CID = require('cids')
const log = require('debug')('ipfs:repo:gc')
const { MFS_ROOT_KEY, withTimeoutOption } = require('../../utils')
const { Errors } = require('interface-datastore')
const ERR_NOT_FOUND = Errors.notFoundError().code
const { parallelMerge, transform, map } = require('streaming-iterables')
const multibase = require('multibase')

// Limit on the number of parallel block remove operations
const BLOCK_RM_CONCURRENCY = 256

// Perform mark and sweep garbage collection
module.exports = ({ gcLock, pin, pinManager, refs, repo }) => {
  return withTimeoutOption(async function * gc (options = {}) {
    const start = Date.now()
    log('Creating set of marked blocks')

    const release = await gcLock.writeLock()

    try {
      // Mark all blocks that are being used
      const markedSet = await createMarkedSet({ pin, pinManager, refs, repo })
      // Get all blocks keys from the blockstore
      const blockKeys = repo.blocks.query({ keysOnly: true })

      // Delete blocks that are not being used
      yield * deleteUnmarkedBlocks({ repo, refs }, markedSet, blockKeys)

      log(`Complete (${Date.now() - start}ms)`)
    } finally {
      release()
    }
  })
}

// Get Set of multihashes of blocks to keep
async function createMarkedSet ({ pin, pinManager, refs, repo }) {
  const pinsSource = map(({ cid }) => cid, pin.ls())

  const pinInternalsSource = (async function * () {
    const cids = await pinManager.getInternalBlocks()
    yield * cids
  })()

  const mfsSource = (async function * () {
    let mh
    try {
      mh = await repo.root.get(MFS_ROOT_KEY)
    } catch (err) {
      if (err.code === ERR_NOT_FOUND) {
        log('No blocks in MFS')
        return
      }
      throw err
    }

    const rootCid = new CID(mh)
    yield rootCid

    for await (const { ref } of refs(rootCid, { recursive: true })) {
      yield new CID(ref)
    }
  })()

  const output = new Set()
  for await (const cid of parallelMerge(pinsSource, pinInternalsSource, mfsSource)) {
    output.add(multibase.encode('base32', cid.multihash).toString())
  }
  return output
}

// Delete all blocks that are not marked as in use
async function * deleteUnmarkedBlocks ({ repo, refs }, markedSet, blockKeys) {
  // Iterate through all blocks and find those that are not in the marked set
  // blockKeys yields { key: Key() }
  let blocksCount = 0
  let removedBlocksCount = 0

  const removeBlock = async (cid) => {
    blocksCount++

    try {
      const b32 = multibase.encode('base32', cid.multihash).toString()
      if (markedSet.has(b32)) return null
      const res = { cid }

      try {
        await repo.blocks.delete(cid)
        removedBlocksCount++
      } catch (err) {
        res.err = new Error(`Could not delete block with CID ${cid}: ${err.message}`)
      }

      return res
    } catch (err) {
      const msg = `Could delete block with CID ${cid}`
      log(msg, err)
      return { err: new Error(msg + `: ${err.message}`) }
    }
  }

  for await (const res of transform(BLOCK_RM_CONCURRENCY, removeBlock, blockKeys)) {
    // filter nulls (blocks that were retained)
    if (res) yield res
  }

  log(`Marked set has ${markedSet.size} unique blocks. Blockstore has ${blocksCount} blocks. ` +
  `Deleted ${removedBlocksCount} blocks.`)
}

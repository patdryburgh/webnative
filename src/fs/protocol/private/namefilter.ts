import { BloomFilter } from 'fission-bloom-filters'
import * as hex from '../../../common/hex'
import { sha256, sha256Str } from '../../../keystore'
import { BareNameFilter, PrivateName, RevisionNameFilter, SaturatedNameFilter } from './types'

const FILTER_SIZE = 1024
const HASH_COUNT = 16
const SATURATION_THRESHOLD = 320

// create bare name filter with a single key
export const createBare = async (key: string): Promise<BareNameFilter> => {
  const empty = "0".repeat(FILTER_SIZE/4)
  return addToBare(empty, key)
}

// add some string to a name filter
export const addToBare = async (bareFilter: BareNameFilter, toAdd: string): Promise<BareNameFilter> =>  {
  const filter = fromHex(bareFilter)
  const hash = await sha256Str(toAdd)
  filter.add(hash)
  return toHex(filter)
}

// add the revision number to the name filter, salted with the AES key for the node
export const addRevision = async (bareFilter: BareNameFilter, key: string, revision: number): Promise<RevisionNameFilter> => {
  return addToBare(bareFilter, revision + key)
}

// saturate the filter to 320 bits and hash it with sha256 to give the pirvate name that a node will be stored in the MMPT with
export const toPrivateName = async (revisionFilter: RevisionNameFilter): Promise<PrivateName> => {
  const saturated = await saturateFilter(fromHex(revisionFilter))
  return toHash(saturated)
}

// hash a filter with sha256
export const toHash = async (filter: BloomFilter): Promise<PrivateName> => {
  const hash = await sha256(filter.toBuffer())
  return hex.fromBuffer(hash)
}

// saturate a filter (string) to 320 bits
export const saturate = async (filter: RevisionNameFilter, threshold = SATURATION_THRESHOLD): Promise<SaturatedNameFilter> => {
  const saturated = await saturateFilter(fromHex(filter), threshold)
  return toHex(saturated)
}

// saturate a filter to 320 bits
const saturateFilter = async (filter: BloomFilter, threshold = SATURATION_THRESHOLD): Promise<BloomFilter> => {
  if(threshold > filter.toBuffer().byteLength * 8) {
    throw new Error("threshold is bigger than filter size")
  }
  const bits = countOnes(filter)
  if(bits >= threshold){
    return filter
  }

  // add hash of filter to saturate
  // theres a chance that the hash will collide with the existing filter and this gets stuck in an infinite loop
  // in that case keep re-hashing the hash & adding to the filter until there is no collision
  const before = filter.toBuffer()
  let toHash = before
  do {
    const hash = await sha256(toHash)
    filter.add(hex.fromBuffer(hash))
    toHash = hash
  } while (bufEquals(before, filter.toBuffer()))

  return saturateFilter(filter, threshold)
}

// count the number of 1 bits in a filter
const countOnes = (filter: BloomFilter): number => {
  const arr = new Uint32Array(filter.toBuffer())
  let count = 0
  for(let i=0; i< arr.length; i++){
    count += bitCount32(arr[i])
  }
  return count
}

// convert a filter to hex
export const toHex = (filter: BloomFilter) => {
  return hex.fromBuffer(filter.toBuffer())
}

// convert hex to a BloomFilter object
export const fromHex = (string: string): BloomFilter => {
  const buf = hex.toBuffer(string)
  return BloomFilter.fromBuffer(buf, HASH_COUNT)
}

const bufEquals = (buf1: ArrayBuffer, buf2: ArrayBuffer): boolean => {
  if(buf1.byteLength !== buf2.byteLength) return false
  const arr1 = new Uint8Array(buf1)
  const arr2 = new Uint8Array(buf2)
  for(let i=0; i<arr1.length; i++){
    if(arr1[i] !== arr2[i]) {
      return false
    }
  }
  return true
}

// counts the number of 1s in a uint32
// from: https://graphics.stanford.edu/~seander/bithacks.html#CountBitsSetParallel
const bitCount32 = (num: number): number => {
  num = num - ((num >> 1) & 0x55555555)
  num = (num & 0x33333333) + ((num >> 2) & 0x33333333)
  return ((num + (num >> 4) & 0xF0F0F0F) * 0x1010101) >> 24
}
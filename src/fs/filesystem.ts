import PublicTreeBare from './bare/tree'
import PublicTree from './v1/PublicTree'
import PrivateTree from './v1/PrivateTree'
import { File, Tree, Links, SyncHook, FileSystemOptions, HeaderTree } from './types'
import { CID, FileContent } from '../ipfs'
import { dataRoot } from '../data-root'

import * as keystore from '../keystore'
import pathUtil from './path'
import { asyncWaterfall } from '../common/util'


// This is by far my favourite way of handling TS params
type ConstructorParams = {
  root: Tree
  publicTree: HeaderTree
  prettyTree: PublicTreeBare
  privateTree: HeaderTree
}


export class FileSystem {

  root: Tree
  publicTree: HeaderTree // Header? UPDATE: Oooh, a tree with headers. Gotcha.
  prettyTree: PublicTreeBare // Bare sounds like it's an empty binary tree -- this is not!
  privateTree: HeaderTree
  syncHooks: Array<SyncHook>

  constructor({ root, publicTree, prettyTree, privateTree }: ConstructorParams) {
    this.root = root
    this.publicTree = publicTree
    this.prettyTree = prettyTree
    this.privateTree = privateTree
    this.syncHooks = []
  }

  static async empty(opts: FileSystemOptions = {}): Promise<FileSystem> {
    const { keyName = 'filesystem-root' } = opts

    const root = await PublicTreeBare.empty()
    const publicTree = await PublicTree.empty(null)
    const prettyTree = await PublicTreeBare.empty()

    const key = await keystore.getKeyByName(keyName)
    const privateTree = await PrivateTree.empty(key)

    return new FileSystem({
      root,
      publicTree,
      prettyTree,
      privateTree,
    })
  }

  static async fromCID(cid: CID, opts: FileSystemOptions = {}): Promise<FileSystem | null> {
    const { keyName = 'filesystem-root' } = opts

    const root = await PublicTreeBare.fromCID(cid)
    const publicCID = root.findLinkCID('public')
    const publicTree = publicCID !== null
                        ? await PublicTree.fromCID(publicCID, null)
                        : null

    const prettyTree = (await root.getDirectChild('pretty')) as PublicTreeBare ||
                        await PublicTreeBare.empty()

    const privateCID = root.findLinkCID('private')
    const key = await keystore.getKeyByName(keyName)
    const privateTree = privateCID !== null
                          ? await PrivateTree.fromCID(privateCID, key)
                          : null

    if (publicTree === null || privateTree === null) return null

    return new FileSystem({
      root,
      publicTree,
      prettyTree,
      privateTree,
    })
  }

  // Nice
  static async forUser(username: string, opts: FileSystemOptions = {}): Promise<FileSystem | null> {
    const cid = await dataRoot(username)
    return FileSystem.fromCID(cid, opts)
  }

  /**
   * Upgrade public IPFS folder to FileSystem
   */
  static async upgradePublicCID(cid: CID, opts: FileSystemOptions = {}): Promise<FileSystem> {
    const { keyName = 'filesystem-root' } = opts

    const root = await PublicTreeBare.empty()
    const publicTree = await PublicTree.fromCID(cid, null)
    const prettyTree = await PublicTreeBare.fromCID(cid)

    const key = await keystore.getKeyByName(keyName)
    const privateTree = await PrivateTree.empty(key)

    return new FileSystem({
      root,
      publicTree,
      prettyTree,
      privateTree,
    })
  }

  // Not sure if this is in an interface (will look), but it should! Docs, dependencies, &c.
  async ls(path: string): Promise<Links> {
    return this.runOnTree(path, false, (tree, relPath) => {
      return tree.ls(relPath)
    })
  }

  async mkdir(path: string): Promise<CID> {
    await this.runOnTree(path, true, (tree, relPath) => {
      return tree.mkdir(relPath)
    })
    return this.sync() // Not a huge fan of the term "sync". Had to think about it a few moments to realize that it wasn't "synchronous"
  }

  async add(path: string, content: FileContent): Promise<CID> {
    await this.runOnTree(path, true, (tree, relPath) => {
      return tree.add(relPath, content)
    })
    return this.sync()
  }

  async cat(path: string): Promise<FileContent | null> {
    return this.runOnTree(path, false, (tree, relPath) => {
      return tree.cat(relPath)
    })
  }

  async rm(path: string): Promise<CID> {
    await this.runOnTree(path, true, (tree, relPath) => {
      return tree.rm(relPath)
    })
    return this.sync()
  }

  async get(path: string): Promise<Tree | File | null> {
    return this.runOnTree(path, false, (tree, relPath) => {
      return tree.get(relPath)
    })
  }

  async pinList(): Promise<CID[]> {
    const privateResult = await this.privateTree.putWithPins()
    const publicResult = await this.publicTree.putWithPins()
    const rootCID = await this.sync()
    // Minor / inconsequential -- Can be rephrased with destructuring
    return [
      ...privateResult.pins,
      ...publicResult.pins,
      rootCID
    ]
  }

  // Maybe rename to pushRemote or other familiar metaphor
  async sync(): Promise<CID> {
    // waterfall? Why not in parallel?
    this.root = await asyncWaterfall(this.root, [
      (t: Tree): Promise<Tree> => t.addChild('public', this.publicTree),
      (t: Tree): Promise<Tree> => t.addChild('pretty', this.prettyTree),
      (t: Tree): Promise<Tree> => t.addChild('private', this.privateTree)
    ])

    const cid = await this.root.put()

    this.syncHooks.forEach(hook => {
      hook(cid)
    })

    return cid
  }

  // Legit don't know what this means: synchronize vs synchronous
  addSyncHook(hook: SyncHook): Array<SyncHook> {
    this.syncHooks = [...this.syncHooks, hook]
    return this.syncHooks
  }

  removeSyncHook(hook: SyncHook): Array<SyncHook> {
    this.syncHooks = this.syncHooks.filter(h => h !== hook)
    return this.syncHooks
  }

  async runOnTree<a>(
    path: string,
    updateTree: boolean, // ie. do a mutation
    fn: (tree: Tree, relPath: string) => Promise<a>
  ): Promise<a> {
    const parts = pathUtil.splitParts(path)
    const head = parts[0]
    const relPath = pathUtil.join(parts.slice(1))

    // Why `a` not FileSystem? TS has subtyping. I easily could be missing something.
    let result: a
    let resultPretty: a

    if (head === 'public') {
      result = await fn(this.publicTree, relPath)

      if (updateTree && PublicTree.instanceOf(result)) {
        resultPretty = await fn(this.prettyTree, relPath)

        this.publicTree = result
        this.prettyTree = resultPretty as unknown as PublicTreeBare
      }

    } else if (head === 'private') {
      result = await fn(this.privateTree, relPath)

      if (updateTree && PrivateTree.instanceOf(result)) {
        this.privateTree = result
      }

      // NOTE TO SELF: pretty ~ reduction ~ view pattern
    } else if (head === 'pretty' && updateTree) {
      throw new Error("The pretty path is read only")

    } else if (head === 'pretty') {
      result = await fn(this.prettyTree, relPath)

    } else {
      throw new Error("Not a valid FileSystem path")

    }

    return result
  }
}


export default FileSystem

import { readdirSync, statSync } from 'node:fs';
import { join, basename, dirname as nodeDirname } from 'node:path';
import type { ScannerConfig, FileSystemNode, LayerResult, DirSummary } from './types.ts';

/** Yield one LayerResult per BFS queue-level. Read-only — zero disk mutations. */
export function* bfsWalk(config: ScannerConfig): Generator<LayerResult> {
  const visited = new Set<string>();
  let queue: string[] = [config.root];
  layerLoop:
  for (let layer = 0; layer <= config.maxDepth; layer++) {
    if (!queue.length) break;

    if (queue.length > config.entryCountLimit) {
      console.error(`[WARN] entry-count limit reached (${config.entryCountLimit}). Scanning partial tree.`);
      break;
    }

    const nextQueue: string[] = [];
    const layerNodes: FileSystemNode[] = [];

    for (const dirPath of queue) {
      let dirSize = 0, dirCtime = 0, dirBtime = 0;
      try {
        const ds = statSync(dirPath);
        dirSize = ds.size; dirCtime = ds.mtime.getTime(); dirBtime = ds.birthtime.getTime();
      } catch (err) { /* inaccessible — skip */ }

      // yield the directory itself as a node
      layerNodes.push({
        path: dirPath,
        name: layer === 0 ? '/' : baseName(dirPath),
        type: 'dir', sizeBytes: dirSize,
        mtimeMs: dirCtime, birthtimeMs: dirBtime, depth: layer, layer,
      });

      if (visited.has(dirPath)) continue;
      visited.add(dirPath);

      let entries: ReturnType<typeof readdirSync> = [];
      try { entries = readdirSync(dirPath, { withFileTypes: true }) }
      catch (_) { /* unreadable — skip subtree */ }

      for (const ent of entries) {
        const fullPath = join(dirPath, ent.name);

        // symlinks → always skip
        if (ent.isSymbolicLink()) continue;

        // dedup across ALL layers
        if (visited.has(fullPath)) continue;

        try {
          const st = statSync(fullPath);
          visited.add(fullPath);

          const isDir = st.isDirectory();
          layerNodes.push({
            path: fullPath, name: ent.name, type: isDir ? 'dir' : 'file',
            sizeBytes: st.size, mtimeMs: st.mtime.getTime(), birthtimeMs: st.birthtime.getTime(),
            depth: layer + (isDir ? 1 : 0), layer,
          });

          if (isDir) nextQueue.push(fullPath);
        } catch (_) { /* permission denied — skip entry */ }
      }
    }

    yield { layer, rootNodePath: config.root, nodes: layerNodes };
    queue = nextQueue;
  }
}

function baseName(p: string): string {
  const lastSlash = p.lastIndexOf('/');
  return lastSlash < 0 ? '' : p.slice(lastSlash + 1);
}

/** Group raw LayerResult nodes into a map of parentDir → DirSummary[] */
export function groupNodesByParent(layers: LayerResult[]): Map<string, DirSummary[]> {
  const byParent = new Map<string, DirSummary[]>();

  for (const layer of layers) {
    // collect children file nodes by their parent directory
    const filesByDir = new Map<string, FileSystemNode[]>();
    for (const node of layer.nodes) {
      if (node.type === 'file') {
        const pp = node.path.split('/').slice(0, -1).join('/') || '/';
        if (!filesByDir.has(pp)) filesByDir.set(pp, []);
        filesByDir.get(pp)!.push(node);
      }
    }

    // merge into the running map
    for (const [pp, nodeFiles] of filesByDir) {
      if (!byParent.has(pp)) byParent.set(pp, []);
      const existing = byParent.get(pp)!;
      for (const nf of nodeFiles) existing.push(nf as unknown as DirSummary);
    }
  }

  return byParent;
}

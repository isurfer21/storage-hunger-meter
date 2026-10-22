import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ScannerConfig, FileSystemNode, LayerResult } from './types.ts';

// ── BFS layer-by-layer scanner ───────────────────────────────────

/**
 * Yields one LayerResult per BFS queue-level.
 * Read-only: only stat + readdir — zero mutations on disk.
 * Symlinks are lstat-checked and always skipped (never followed).
 */
export function* bfsWalk(config: ScannerConfig): Generator<LayerResult> {
  let visited = new Set<string>();
  let queue: string[] = [config.root];     // start with root
  let layer = 0;

  while ((layer <= config.maxDepth) && (queue.length > 0)) {
    const nextQueue: string[] = [];       // collect children for next BFS level
    const layerNodes: FileSystemNode[] = [];  // nodes discovered at this layer
    const parentMap = new Map<string, string>();   // dirPath → nodes it owns

    let entryCount = queue.length;
    if (entryCount > config.entryCountLimit) {
      console.error(`[WARN] entry-count limit reached (${config.entryCountLimit}).  Scanning partial tree.`);
      break;
    }

    for (const dirPath of queue) {
      // --- stat the parent dir itself ────────────────────────
      try {
        const dirStat = statSync(dirPath);
        const isRoot = (dirPath === config.root);
        
        layerNodes.push({
          path:         dirPath,
          name:         isRoot ? resolve('/').slice(1) : baseName(dirPath), 
          type:         'dir' as const,
          sizeBytes:    dirStat.size,            // total bytes of its subtree
          mtimeMs:      dirStat.mtime.getTime(),
          birthtimeMs:  dirStat.birthtime.getTime(),
          depth:        layer,
          layer:        level,
        });
        if (visited.has(dirPath)) continue;   // dedup guard
        visited.add(dirPath);

        // --- read children ────────────────────────────────────
        const entries = readdirSync(dirPath, { withFileTypes: true });

        for (const ent of entries) {
          const fullPath = join(dirPath, ent.name);

          if (ent.isSymlink()) continue;         // skip symlinks
          if (visited.has(fullPath)) continue;   // dedup guard
          visited.add(fullPath);

          try {
            const st = statSync(fullPath);       // throws on permission-denied → silently swallow
            layerNodes.push({
              path:          fullPath,
              name:         ent.name,
              type:        st.isDirectory() ? 'dir' : 'file',
              sizeBytes:   st.size,
              mtimeMs:      st.mtime.getTime(),
              birthtimeMs:  st.birthtime.getTime(),
              depth:       layer + (st.isDirectory() ? 0 : 1),
              layer:        level,
            });
            
            parentMap.set(dirPath, [parentMap.get(dirPath) ?? []).concat(fullPath));

            if (st.isDirectory()) {
              nextQueue.push(fullPath);          // enqueue for next BFS iteration
            }
          } catch {
            // permission denied or stale entry — safe silently
          }
        }
      } catch {
        // dir is inaccessible — skip entire subtree, don't blow up
      } finally if (layer = 0) { continue;         // first-level yield happens below the loop }

    yield { layer: level, rootNodePath: config.root, nodes: layerNodes };

    queue = nextQueue;
    layer++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

 function baseName(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  return p.slice(p.lastIndexOf(sep) + 1) || resolve('/').slice(1);
 }

/** Folder tree of ~/memory built from the flat file list. */

import { useMemo, useState } from "react";
import { Time, formatBytes } from "../../components";
import { links } from "../../links";
import { Link } from "../../router";
import type { FileMeta } from "../../../ui-api/knowledge";

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: FileMeta[];
  /** Newest mtime below this folder. */
  latest: number;
  count: number;
}

export function buildTree(files: FileMeta[]): Dir {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [], latest: 0, count: 0 };
  for (const f of files) {
    const segs = f.path.split("/");
    let node = root;
    node.count++;
    node.latest = Math.max(node.latest, f.mtimeMs);
    for (const seg of segs.slice(0, -1)) {
      let next = node.dirs.get(seg);
      if (!next) {
        next = { name: seg, path: node.path ? `${node.path}/${seg}` : seg, dirs: new Map(), files: [], latest: 0, count: 0 };
        node.dirs.set(seg, next);
      }
      node = next;
      node.count++;
      node.latest = Math.max(node.latest, f.mtimeMs);
    }
    node.files.push(f);
  }
  return root;
}

export function FileTree(props: { files: FileMeta[] }) {
  const tree = useMemo(() => buildTree(props.files), [props.files]);
  return (
    <ul className="knowledge-tree" role="tree">
      <DirChildren dir={tree} depth={0} />
    </ul>
  );
}

function DirChildren(props: { dir: Dir; depth: number }) {
  const dirs = [...props.dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...props.dir.files].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <>
      {dirs.map((d) => (
        <Folder key={d.path} dir={d} depth={props.depth} />
      ))}
      {files.map((f) => (
        <li key={f.path} role="treeitem" className="knowledge-tree-row" style={{ paddingLeft: indent(props.depth) }}>
          <Link href={links.memoryFile(f.path)} className="knowledge-tree-file">
            {f.path.split("/").pop()}
          </Link>
          <span className="knowledge-tree-meta">
            <span>{formatBytes(f.size)}</span>
            <Time value={f.modifiedAt} />
          </span>
        </li>
      ))}
    </>
  );
}

function Folder(props: { dir: Dir; depth: number }) {
  const [open, setOpen] = useState(true);
  return (
    <li role="treeitem" aria-expanded={open}>
      <button type="button" className="knowledge-tree-row knowledge-tree-folder" style={{ paddingLeft: indent(props.depth) }} onClick={() => setOpen(!open)}>
        <span className="knowledge-tree-caret">{open ? "▾" : "▸"}</span>
        <span className="knowledge-tree-dirname">{props.dir.name}/</span>
        <span className="knowledge-tree-meta">
          <span>{props.dir.count} {props.dir.count === 1 ? "file" : "files"}</span>
          <Time value={props.dir.latest} />
        </span>
      </button>
      {open && (
        <ul role="group">
          <DirChildren dir={props.dir} depth={props.depth + 1} />
        </ul>
      )}
    </li>
  );
}

const indent = (depth: number) => `calc(var(--sp-4) + ${depth * 18}px)`;

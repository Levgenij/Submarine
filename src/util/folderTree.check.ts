import { folderTree } from "./folderTree.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: ${a} !== ${e}`);
}

const ids = (rows: { id: number }[]) => rows.map((f) => f.id);

const folders = [
  { id: 1, name: "Clients", parent_id: null },
  { id: 2, name: "Acme", parent_id: 1 },
  { id: 3, name: "Prod", parent_id: 2 },
  { id: 4, name: "Orphan", parent_id: 99 },
  { id: 5, name: "LoopA", parent_id: 6 },
  { id: 6, name: "LoopB", parent_id: 5 },
  { id: 7, name: "IntoLoop", parent_id: 5 },
];
const tree = folderTree(folders);

eq(ids(tree.childrenOf(null)), [1, 4, 5, 6], "missing parent and a loop stay at the top");
eq(ids(tree.childrenOf(1)), [2], "a folder lists only its own children");
eq(ids(tree.childrenOf(2)), [3], "nested child");
eq(tree.parentOf(3), 2, "parent");
eq(tree.parentOf(4), null, "missing parent");
eq(tree.parentOf(5), null, "loop sits at the top");
eq(tree.parentOf(7), 5, "a folder hanging off a loop stays under that folder");
eq(ids(tree.childrenOf(5)), [7], "the hanging folder is still listed");
eq(tree.has(4), true, "orphan is still in the tree");
eq(tree.label(3), "Clients / Acme / Prod", "full path");
eq(tree.pathOf(3).map((f) => f.name), ["Clients", "Acme", "Prod"], "path steps");
eq([...tree.subtreeOf(1)].sort((a, b) => a - b), [1, 2, 3], "subtree");
eq(tree.subtreeOf(1).has(1), true, "a folder is inside its own subtree");
eq(tree.serverFolder({ folder_id: 3 }), 3, "server in a real folder");
eq(tree.serverFolder({ folder_id: 99 }), null, "a missing folder shows the server at the top");
eq(tree.serverFolder({ folder_id: null }), null, "no folder");
eq(tree.serverFolder(null), null, "no server");

console.log("folderTree ok");

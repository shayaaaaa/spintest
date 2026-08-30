// Retires resource nodes that have been worked out.
//
// A stripped tree shouldn't keep standing there looking harvestable, so it
// falls and rots away, and once it's gone its tile stops blocking movement.
// Gold mines are left in place: an exhausted mine is still a landmark, and
// nothing about it obstructs anyone.

// How long a felled tree takes to topple and rot away. The renderer reads the
// same span off the tree to draw it going over, so the two stay in step.
export const TREE_FALL_SECONDS = 10;

export function updateResourceNodes(ctx) {
  // Snapshot first: retiring a node removes it from the store mid-iteration.
  for (const node of [...ctx.store.resourceNodes]) {
    if (node.resourceType !== 'lumber' || node.amount > 0) continue;
    const tx = Math.floor(node.x), ty = Math.floor(node.y);

    if (node.felledAt === undefined) {
      node.felledAt = ctx.time;
      const tree = ctx.map.treeAt(tx, ty);
      if (tree) tree.felledAt = ctx.time; // the renderer animates from this
      continue;
    }

    if (ctx.time - node.felledAt >= TREE_FALL_SECONDS) {
      ctx.map.removeTree(tx, ty);
      ctx.store.remove(node);
    }
  }
}

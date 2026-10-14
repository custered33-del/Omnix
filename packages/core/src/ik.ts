import type { Bone, Rig, RigPose } from './nodes.js';
import type { Point } from './types.js';
import { ease } from './keyframes.js';

/** World-space transform of a bone: start point, end point and absolute angle. */
export interface BoneWorld {
  id: string;
  start: Point;
  end: Point;
  angle: number;
}

/**
 * Forward kinematics: compute world positions for every bone.
 * Bones are processed parents-first; a bone's start is its parent's end.
 */
export function forwardKinematics(bones: readonly Bone[], angles?: Record<string, number>): Map<string, BoneWorld> {
  const byId = new Map(bones.map((b) => [b.id, b]));
  const out = new Map<string, BoneWorld>();
  const visit = (bone: Bone, depth: number): BoneWorld => {
    const cached = out.get(bone.id);
    if (cached) return cached;
    if (depth > bones.length) throw new Error(`Bone hierarchy contains a cycle at ${bone.id}`);
    const local = angles?.[bone.id] ?? bone.angle;
    let start: Point;
    let parentAngle = 0;
    if (bone.parentId && byId.has(bone.parentId)) {
      const parent = visit(byId.get(bone.parentId)!, depth + 1);
      start = parent.end;
      parentAngle = parent.angle;
    } else {
      start = { x: bone.x, y: bone.y };
    }
    const angle = parentAngle + local;
    const end = { x: start.x + Math.cos(angle) * bone.length, y: start.y + Math.sin(angle) * bone.length };
    const world = { id: bone.id, start, end, angle };
    out.set(bone.id, world);
    return world;
  };
  for (const b of bones) visit(b, 0);
  return out;
}

/** The chain of bones from the root down to `endBoneId` (inclusive), root first. */
export function boneChain(bones: readonly Bone[], endBoneId: string, maxLength = Infinity): Bone[] {
  const byId = new Map(bones.map((b) => [b.id, b]));
  const chain: Bone[] = [];
  let cur = byId.get(endBoneId);
  while (cur && chain.length < maxLength) {
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * Inverse kinematics using FABRIK (Forward And Backward Reaching IK).
 * Moves the tip of `endBoneId` toward `target`, solving for the chain of up to `chainLength` bones.
 * Returns new local angles for the bones in the chain (other bones unchanged).
 */
export function solveIK(
  bones: readonly Bone[],
  endBoneId: string,
  target: Point,
  options: { chainLength?: number; iterations?: number; tolerance?: number; angles?: Record<string, number> } = {},
): Record<string, number> {
  const { chainLength = Infinity, iterations = 20, tolerance = 0.01 } = options;
  const baseAngles: Record<string, number> = {};
  for (const b of bones) baseAngles[b.id] = options.angles?.[b.id] ?? b.angle;
  const chain = boneChain(bones, endBoneId, chainLength);
  if (chain.length === 0) return baseAngles;

  const world = forwardKinematics(bones, baseAngles);
  const joints: Point[] = [world.get(chain[0]!.id)!.start, ...chain.map((b) => world.get(b.id)!.end)];
  const lengths = chain.map((b) => b.length);
  const root = { ...joints[0]! };
  const total = lengths.reduce((a, b) => a + b, 0);
  const distToTarget = Math.hypot(target.x - root.x, target.y - root.y);

  if (distToTarget >= total) {
    // Unreachable: stretch toward the target.
    for (let i = 0; i < lengths.length; i++) {
      const prev = joints[i]!;
      const d = Math.hypot(target.x - prev.x, target.y - prev.y) || 1;
      const k = lengths[i]! / d;
      joints[i + 1] = { x: prev.x + (target.x - prev.x) * k, y: prev.y + (target.y - prev.y) * k };
    }
  } else {
    for (let iter = 0; iter < iterations; iter++) {
      // Backward pass: tip to target.
      joints[joints.length - 1] = { ...target };
      for (let i = joints.length - 2; i >= 0; i--) {
        const next = joints[i + 1]!;
        const cur = joints[i]!;
        const d = Math.hypot(cur.x - next.x, cur.y - next.y) || 1;
        const k = lengths[i]! / d;
        joints[i] = { x: next.x + (cur.x - next.x) * k, y: next.y + (cur.y - next.y) * k };
      }
      // Forward pass: root back to its anchor.
      joints[0] = { ...root };
      for (let i = 0; i < joints.length - 1; i++) {
        const cur = joints[i]!;
        const next = joints[i + 1]!;
        const d = Math.hypot(next.x - cur.x, next.y - cur.y) || 1;
        const k = lengths[i]! / d;
        joints[i + 1] = { x: cur.x + (next.x - cur.x) * k, y: cur.y + (next.y - cur.y) * k };
      }
      const tip = joints[joints.length - 1]!;
      if (Math.hypot(tip.x - target.x, tip.y - target.y) < tolerance) break;
    }
  }

  // Convert joint positions back to local angles.
  const result = { ...baseAngles };
  const firstParent = chain[0]!.parentId ? world.get(chain[0]!.parentId!) : undefined;
  let parentAngle = firstParent ? firstParent.angle : 0;
  for (let i = 0; i < chain.length; i++) {
    const a = joints[i]!;
    const b = joints[i + 1]!;
    const absolute = Math.atan2(b.y - a.y, b.x - a.x);
    result[chain[i]!.id] = normalizeAngle(absolute - parentAngle);
    parentAngle = absolute;
  }
  return result;
}

export function normalizeAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** Shortest-path angle interpolation. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + normalizeAngle(b - a) * t;
}

/** Evaluate a rig's pose at time t (seconds relative to the layer) by interpolating stored poses. */
export function evaluateRig(rig: Rig, t: number): Record<string, number> {
  const base: Record<string, number> = {};
  for (const b of rig.bones) base[b.id] = b.angle;
  if (rig.poses.length === 0) return base;
  const poses = [...rig.poses].sort((a, b) => a.time - b.time);
  const merged = (p: RigPose) => ({ ...base, ...p.angles });
  if (t <= poses[0]!.time) return merged(poses[0]!);
  const last = poses[poses.length - 1]!;
  if (t >= last.time) return merged(last);
  for (let i = 0; i < poses.length - 1; i++) {
    const a = poses[i]!;
    const b = poses[i + 1]!;
    if (t >= a.time && t <= b.time) {
      const p = ease(a.easing, (t - a.time) / Math.max(1e-9, b.time - a.time));
      const ma = merged(a);
      const mb = merged(b);
      const out: Record<string, number> = {};
      for (const id of Object.keys(base)) out[id] = lerpAngle(ma[id]!, mb[id]!, p);
      return out;
    }
  }
  return merged(last);
}

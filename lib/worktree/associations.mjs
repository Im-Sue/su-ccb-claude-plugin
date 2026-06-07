import { ValidationError } from "../runtime/index.mjs";

const associationExecutors = new Map();

function requireExecutor(kind, executor) {
  if (!executor || typeof executor.sync !== "function" || typeof executor.verify !== "function") {
    throw new ValidationError(`association executor must implement sync and verify: ${kind}`);
  }
  return executor;
}

export function registerAssociationExecutor(kind, executor) {
  if (typeof kind !== "string" || kind.trim().length === 0) {
    throw new ValidationError("association executor kind must be a non-empty string");
  }
  associationExecutors.set(kind, requireExecutor(kind, executor));
}

export function getAssociationExecutor(kind) {
  return associationExecutors.get(kind) ?? null;
}

export function unregisterAssociationExecutor(kind) {
  associationExecutors.delete(kind);
}

export function clearAssociationExecutorsForTest() {
  associationExecutors.clear();
  registerBuiltInAssociationExecutors();
}

function registerBuiltInAssociationExecutors() {
  registerAssociationExecutor("test_fake_association", {
    async sync({ projectRoot, requirementId, association, spacesById, runGit }) {
      if (!projectRoot || !requirementId) {
        throw new ValidationError("test fake association requires projectRoot and requirementId");
      }
      const fromSpace = spacesById.get(association.from_space);
      const toSpace = spacesById.get(association.to_space);
      if (!fromSpace || !toSpace) {
        throw new ValidationError(`test fake association cannot resolve spaces: ${association.association_id}`);
      }
      if (association.association_id.includes("sync-fail")) {
        throw new ValidationError(`test fake association sync failed: ${association.association_id}`);
      }
      const syncedCommit = await runGit(toSpace.repoRoot, ["rev-parse", "HEAD"]);
      return {
        synced_commit_sha: `${syncedCommit.stdout.trim()}:${fromSpace.space_id}->${toSpace.space_id}`,
        noop: association.association_id.includes("noop")
      };
    },
    async verify({ projectRoot, requirementId, association, spacesById, runGit }) {
      if (!projectRoot || !requirementId) {
        throw new ValidationError("test fake association requires projectRoot and requirementId");
      }
      const toSpace = spacesById.get(association.to_space);
      if (!toSpace) {
        throw new ValidationError(`test fake association cannot resolve to_space: ${association.to_space}`);
      }
      await runGit(toSpace.repoRoot, ["rev-parse", "--verify", "HEAD"]);
      return !association.association_id.includes("verify-fail");
    }
  });
}

registerBuiltInAssociationExecutors();

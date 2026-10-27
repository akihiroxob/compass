import { fullCommitSha, httpUrl, parseWith, repositoryRelativePath, trimmedText, ValidationError } from "@compass/shared";
import { z } from "zod";
import type { AcceptedDeliverable } from "./port/WorkStore.ts";

export const maximumAcceptedDeliverables = 20;
export const maximumAcceptedPaths = 50;

/**
 * `accept_task`の受入成果物（任意）。受け入れるManagerが確認したRepository・完全なcommit SHA・変更したpath・PR URLを
 * 受入証跡としてTASK_ACCEPTEDのChangeへ残す。本文は持たず、Repositoryが正本のまま参照だけを保持する。
 */
const deliverableSchema = z
  .object({
    repositoryId: trimmedText("repositoryId", 200),
    commitSha: fullCommitSha.transform((value) => value.toLowerCase()),
    paths: z.array(repositoryRelativePath).min(1).max(maximumAcceptedPaths).transform((paths) => [...new Set(paths)]),
    pullRequestUrl: httpUrl("pullRequestUrl").nullable().optional().transform((value) => value ?? null),
  })
  .strict();

const acceptanceSchema = z.object({ deliverables: z.array(deliverableSchema).max(maximumAcceptedDeliverables) });

export const parseAcceptedDeliverables = (input: unknown): AcceptedDeliverable[] =>
  parseWith(acceptanceSchema, { deliverables: input ?? [] }, "Task acceptance").deliverables;

/**
 * PR URLがRepositoryのpull requestか。http(s)のRepositoryでは`{Repository URL}/pull/{番号}`だけを受け付け、
 * それ以外（ローカルの検証用Repository等）はPRを持たないため`null`だけを受け付ける。
 */
export const isPullRequestOf = (repositoryUrl: string, pullRequestUrl: string | null): boolean => {
  if (!/^https?:\/\//i.test(repositoryUrl)) return pullRequestUrl === null;
  if (pullRequestUrl === null) return true;
  const base = repositoryUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  const prefix = `${base}/pull/`;
  const url = pullRequestUrl.toLowerCase().replace(/\/+$/, "");
  return url.startsWith(prefix) && /^\d+$/.test(url.slice(prefix.length));
};

/** 受入成果物のRepositoryがTaskのProjectに登録され、PR URLがそのRepositoryのものか。 */
export const assertDeliverablesBelongTo = async (
  deliverables: AcceptedDeliverable[],
  repositories: (repositoryId: string) => Promise<{ url: string } | null>,
): Promise<void> => {
  const issues: { path: string; message: string }[] = [];
  for (const [index, deliverable] of deliverables.entries()) {
    const repository = await repositories(deliverable.repositoryId);
    if (!repository) {
      issues.push({ path: `deliverables.${index}.repositoryId`, message: `Repository ${deliverable.repositoryId} is not registered in the Task's Project` });
    } else if (!isPullRequestOf(repository.url, deliverable.pullRequestUrl)) {
      issues.push({
        path: `deliverables.${index}.pullRequestUrl`,
        message: /^https?:\/\//i.test(repository.url)
          ? `pullRequestUrl must be a pull request of ${repository.url} ({Repository URL}/pull/{number})`
          : "pullRequestUrl must be null for a Repository without an http(s) URL",
      });
    }
  }
  if (issues.length) throw new ValidationError("Task acceptance input is invalid", issues);
};

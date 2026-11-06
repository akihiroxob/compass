import assert from "node:assert/strict";
import test from "node:test";
import {
  changesOfPublication,
  clearedReleaseSearch,
  commitUrl,
  countByPublication,
  filterReleaseChanges,
  hasReleaseFilter,
  paginateReleaseChanges,
  parseReleaseChange,
  parseReleaseFilter,
  publicationNote,
  publicationsOfChange,
  publicationSourceNote,
  relationOf,
  releaseSearch,
  type PublicationRecordView,
  type PublicationStatus,
  type ReleaseChange,
} from "../src/web/features/release/release.ts";

/** Web UIのリリース履歴。公開状況はAPIの値をそのまま扱い、受入やmergeから推測しない。 */

const change = (id: string, status: PublicationStatus, patch: Partial<ReleaseChange> = {}, acceptedAt: number | null = 1_000): ReleaseChange => ({
  task: { id, title: `変更 ${id}`, status: "accepted", storyId: "s1", updatedAt: 500 },
  story: { id: "s1", title: "ログインを改善する", outcomeId: "o1" },
  development: { status: acceptedAt === null ? "not_accepted" : "accepted", acceptedAt, acceptedBy: acceptedAt === null ? null : "manager" },
  pullRequest: { repositoryId: "r1", repository: "acme/widget", number: 7, url: "https://github.com/acme/widget/pull/7", state: "merged", headSha: "a".repeat(40), mergeSha: "b".repeat(40), reviewedHeadSha: null, acceptedMergeSha: null },
  revisions: [{ repositoryId: "r1", commitSha: `${id}`.padEnd(40, "0"), source: "pull_request_merge" }],
  publication: { status, reason: status === "unconfirmed" ? "no_record" : null, publishedAt: status === "published" ? 2_000 : null, targets: [] },
  ...patch,
});

test("URLのqueryから条件・ページ・詳細を読み、不正値は既定へ戻す", () => {
  assert.deepEqual(parseReleaseFilter(new URLSearchParams("q= login &publication=published&page=3")), { q: "login", publication: "published", page: 3 });
  assert.deepEqual(parseReleaseFilter(new URLSearchParams("publication=bogus&page=-1")), { q: "", publication: "all", page: 1 });
  assert.deepEqual(parseReleaseFilter(new URLSearchParams("page=1.5")), { q: "", publication: "all", page: 1 });
  assert.equal(parseReleaseChange(new URLSearchParams("change=t1")), "t1");
  assert.equal(parseReleaseChange(new URLSearchParams("")), null);
  assert.equal(hasReleaseFilter(parseReleaseFilter(new URLSearchParams("view=releases"))), false);
});

test("条件の変更は1ページ目へ戻り、viewと詳細は維持し、解除で条件だけを外す", () => {
  const current = new URLSearchParams("view=releases&page=4&publication=published&change=t1");
  assert.equal(releaseSearch(current, { q: "abc" }), "?view=releases&publication=published&change=t1&q=abc");
  assert.equal(releaseSearch(current, { page: 5 }), "?view=releases&page=5&publication=published&change=t1");
  assert.equal(releaseSearch(current, { change: null }), "?view=releases&page=4&publication=published");
  assert.equal(clearedReleaseSearch(new URLSearchParams("view=releases&q=x&publication=unconfirmed&page=2")), "?view=releases");
  assert.equal(releaseSearch(new URLSearchParams("view=releases&page=3"), { page: 1 }), "?view=releases");
});

test("公開状況と検索語で絞り込み、確認できずを公開済み・未公開へ混ぜない", () => {
  const changes = [change("t1", "published"), change("t2", "not_published"), change("t3", "unconfirmed"), change("t4", "unconfirmed", { story: null }, null)];
  assert.deepEqual(filterReleaseChanges(changes, { q: "", publication: "unconfirmed", page: 1 }).map(({ task }) => task.id), ["t3", "t4"]);
  assert.deepEqual(filterReleaseChanges(changes, { q: "ログイン t1", publication: "all", page: 1 }).map(({ task }) => task.id), ["t1"]);
  assert.deepEqual(filterReleaseChanges(changes, { q: "#7", publication: "all", page: 1 }).length, 4);
  assert.deepEqual(filterReleaseChanges(changes, { q: "存在しない語", publication: "all", page: 1 }).length, 0);
  assert.deepEqual(countByPublication(changes), { published: 1, not_published: 1, unconfirmed: 2 });
});

test("新しい順にページを切り出し、範囲外のページは最後へ寄せる", () => {
  const changes = Array.from({ length: 45 }, (_, index) => change(`t${index}`, "unconfirmed", {}, 1_000 + index));
  const first = paginateReleaseChanges(changes, 1);
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0]!.task.id, "t44");
  assert.equal(first.pageCount, 3);
  assert.equal(paginateReleaseChanges(changes, 3).items.length, 5);
  assert.equal(paginateReleaseChanges(changes, 99).page, 3);
  assert.deepEqual(paginateReleaseChanges([], 2), { items: [], page: 1, pageCount: 1, total: 0 });
  // 受入前の変更は更新日時で並ぶ。
  assert.equal(paginateReleaseChanges([change("old", "unconfirmed", {}, null), change("new", "unconfirmed", {}, 900)], 1).items[0]!.task.id, "new");
});

const record = (id: string, patch: Partial<PublicationRecordView>): PublicationRecordView => ({
  id, repositoryId: "r1", target: "production", targetUrl: null, revision: "f".repeat(40), method: null, observedAt: 3_000, receivedAt: 3_001, sequence: 1,
  principalId: "runtime", evidence: [{ kind: "deployment", uri: "https://deploy.example/1" }], includedCommits: [], notIncludedCommits: [], current: true, ...patch,
});

test("公開記録から関係する変更を辿り、1件の記録に複数Taskを含められる", () => {
  const t1 = change("t1", "published");
  const t2 = change("t2", "published");
  const t3 = change("t3", "not_published");
  const shared = record("p1", { includedCommits: [t1.revisions[0]!.commitSha, t2.revisions[0]!.commitSha], notIncludedCommits: [t3.revisions[0]!.commitSha] });
  const other = record("p2", { repositoryId: "r2", includedCommits: [t1.revisions[0]!.commitSha] });
  assert.deepEqual(changesOfPublication(shared, [t1, t2, t3]).map(({ task }) => task.id), ["t1", "t2", "t3"]);
  assert.deepEqual(publicationsOfChange(t1, [shared, other]).map(({ id }) => id), ["p1"]);
  assert.equal(relationOf(shared, t1), "included");
  assert.equal(relationOf(shared, t3), "not_included");
  assert.equal(relationOf(record("p3", {}), t1), "not_compared");
});

test("確認できない理由と入力元の状態を、公開済み・未公開として表示しない", () => {
  assert.match(publicationNote(change("t1", "unconfirmed").publication), /公開記録がまだありません/);
  assert.match(publicationNote({ status: "unconfirmed", reason: "not_configured", publishedAt: null, targets: [] }), /入力元が設定されておらず/);
  assert.match(publicationNote(change("t1", "not_published").publication), /含まれていません/);
  assert.match(publicationSourceNote({ configured: false, sourceConfigured: false, recordCount: 0 })!, /確認できず/);
  assert.match(publicationSourceNote({ configured: true, sourceConfigured: true, recordCount: 0 })!, /公開記録はまだありません/);
  assert.equal(publicationSourceNote({ configured: true, sourceConfigured: true, recordCount: 2 }), null);
});

test("CommitのURLはGitHubのRepositoryだけに作る", () => {
  const sha = "c".repeat(40);
  assert.equal(commitUrl("https://github.com/acme/widget.git", sha), `https://github.com/acme/widget/commit/${sha}`);
  assert.equal(commitUrl("https://gitlab.example/acme/widget", sha), null);
  assert.equal(commitUrl(undefined, sha), null);
});

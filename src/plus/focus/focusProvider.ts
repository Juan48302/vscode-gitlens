import type { CancellationToken } from 'vscode';
import { Disposable, EventEmitter } from 'vscode';
import type { Container } from '../../container';
import { CancellationError } from '../../errors';
import { getBranchId } from '../../git/models/branch';
import type { SearchedIssue } from '../../git/models/issue';
import { RepositoryAccessLevel } from '../../git/models/issue';
import type { SearchedPullRequest } from '../../git/models/pullRequest';
import {
	PullRequestMergeableState,
	PullRequestReviewDecision,
	PullRequestStatusCheckRollupState,
} from '../../git/models/pullRequest';
import type { GitBranchReference } from '../../git/models/reference';
import { createReference } from '../../git/models/reference';
import type { Repository } from '../../git/models/repository';
import type { GkProviderId, RepositoryIdentityDescriptor } from '../../gk/models/repositoryIdentities';
import { getSettledValue } from '../../system/promise';
import { HostedProviderId } from '../integrations/providers/models';
import type { EnrichableItem, EnrichedItem } from './enrichmentService';

export const focusActionCategories = [
	'mergeable',
	'mergeable-conflicts',
	'failed-checks',
	'needs-review',
	'conflicts',
	'changes-requested',
	'waiting-for-review',
] as const;
export type FocusActionCategory = (typeof focusActionCategories)[number];

export const focusGroups = [
	'pinned',
	'mergeable',
	'blocked',
	'follow-up',
	'needs-attention',
	'needs-review',
	'waiting-for-review',
	'snoozed',
] as const;
export type FocusGroup = (typeof focusGroups)[number];

export const focusCategoryToGroupMap = new Map<FocusActionCategory, FocusGroup>([
	// ['pinned', 'pinned'],
	['mergeable', 'mergeable'],
	['mergeable-conflicts', 'blocked'],
	['failed-checks', 'blocked'],
	['conflicts', 'blocked'],
	['needs-review', 'needs-review'],
	['changes-requested', 'follow-up'],
	['waiting-for-review', 'waiting-for-review'],
	// ['snoozed', 'snoozed'],
]);

export type FocusAction = 'open' | 'merge' | 'review' | 'switch' | 'change-reviewers' | 'nudge' | 'decline-review';

const prActionsMap = new Map<FocusActionCategory, FocusAction[]>([
	['mergeable', ['merge', 'switch', 'open']],
	['mergeable-conflicts', ['switch', 'open']],
	['failed-checks', ['switch', 'open']],
	['conflicts', ['switch', 'open']],
	['needs-review', ['review', 'decline-review', 'open']],
	['changes-requested', ['switch', 'open']],
	['waiting-for-review', ['nudge', 'change-reviewers', 'switch', 'open']],
]);

export type FocusItem = {
	type: 'pullRequest' | 'issue';
	id: string;
	uniqueId: string;
	title: string;
	date: Date;
	author: string;
	avatarUrl: string;
	repoAndOwner: string;
	url: string;

	enrichable: EnrichableItem;
	enriched?: EnrichedItem;

	actionableCategory: FocusActionCategory;
	suggestedActions: FocusAction[];

	pinned: boolean;
	snoozed: boolean;
	sortTime: number;

	repository?: Repository;
	repositoryIdentity?: RepositoryIdentityDescriptor;
	ref?: {
		branchName: string;
		sha: string;
		remoteName: string;
	};
};

type CachedFocusPromise<T> = {
	expiresAt: number;
	promise: Promise<T | undefined>;
};

const cacheExpiration = 1000 * 60 * 30; // 30 minutes

export interface FocusRefreshEvent {
	items: FocusItem[];
}

export class FocusProvider implements Disposable {
	private readonly _onDidChange = new EventEmitter<void>();
	get onDidChange() {
		return this._onDidChange.event;
	}

	private readonly _onDidRefresh = new EventEmitter<FocusRefreshEvent>();
	get onDidRefresh() {
		return this._onDidRefresh.event;
	}

	private readonly _disposable: Disposable;

	constructor(private readonly container: Container) {
		this._disposable = Disposable
			.from
			// configuration.onDidChange(this.onConfigurationChanged, this),
			();
	}

	dispose() {
		this._disposable.dispose();
	}

	private _issues: CachedFocusPromise<SearchedIssue[]> | undefined;
	private async getIssues(options?: { cancellation?: CancellationToken; force?: boolean }) {
		if (options?.force || this._issues == null || this._issues.expiresAt < Date.now()) {
			this._issues = {
				promise: this.container.integrations.getMyIssues([HostedProviderId.GitHub], options?.cancellation),
				expiresAt: Date.now() + cacheExpiration,
			};
		}

		return this._issues?.promise;
	}

	private _prs: CachedFocusPromise<SearchedPullRequest[]> | undefined;
	private async getPullRequests(options?: { cancellation?: CancellationToken; force?: boolean }) {
		if (options?.force || this._prs == null || this._prs.expiresAt < Date.now()) {
			this._prs = {
				promise: this.container.integrations.getMyPullRequests(
					[HostedProviderId.GitHub],
					options?.cancellation,
				),
				expiresAt: Date.now() + cacheExpiration,
			};
		}

		return this._prs?.promise;
	}

	private _enrichedItems: CachedFocusPromise<EnrichedItem[]> | undefined;
	private async getEnrichedItems(options?: { cancellation?: CancellationToken; force?: boolean }) {
		if (options?.force || this._enrichedItems == null || this._enrichedItems.expiresAt < Date.now()) {
			this._enrichedItems = {
				promise: this.container.enrichments.get(undefined, options?.cancellation),
				expiresAt: Date.now() + cacheExpiration,
			};
		}

		return this._enrichedItems?.promise;
	}

	refresh() {
		this._issues = undefined;
		this._prs = undefined;
		this._enrichedItems = undefined;

		this._onDidChange.fire();
	}

	async pin(item: FocusItem) {
		item.pinned = true;
		this._onDidChange.fire();

		await this.container.enrichments.pinItem(item.enrichable);
		this._enrichedItems = undefined;
		this._onDidChange.fire();
	}

	async unpin(item: FocusItem) {
		item.pinned = false;
		this._onDidChange.fire();

		if (item.enriched == null) return;
		await this.container.enrichments.unpinItem(item.enriched.id);
		this._enrichedItems = undefined;
		this._onDidChange.fire();
	}

	async snooze(item: FocusItem) {
		item.snoozed = true;
		this._onDidChange.fire();

		await this.container.enrichments.snoozeItem(item.enrichable);
		this._enrichedItems = undefined;
		this._onDidChange.fire();
	}

	async unsnooze(item: FocusItem) {
		item.snoozed = false;
		this._onDidChange.fire();

		if (item.enriched == null) return;
		await this.container.enrichments.unsnoozeItem(item.enriched.id);
		this._enrichedItems = undefined;
		this._onDidChange.fire();
	}

	async locateItemRepository(
		item: FocusItem,
		options?: { force?: boolean; openIfNeeded?: boolean; keepOpen?: boolean; prompt?: boolean },
	): Promise<Repository | undefined> {
		if (item.repository != null && !options?.force) return item.repository;
		if (item.repositoryIdentity == null) return undefined;

		return this.container.repositoryIdentity.getRepository(item.repositoryIdentity, {
			...options,
			skipRefValidation: true,
		});
	}

	async getItemBranchRef(item: FocusItem): Promise<GitBranchReference | undefined> {
		if (item.ref?.remoteName == null || item.repository == null) return undefined;

		const remoteName = item.ref.remoteName;
		const remotes = await item.repository.getRemotes({ filter: r => r.provider?.owner === remoteName });
		const matchingRemote = remotes.length > 0 ? remotes[0] : undefined;
		let remoteBranchName = `${item.ref.remoteName}/${item.ref.branchName}`;
		if (matchingRemote != null) {
			remoteBranchName = `${matchingRemote.name}/${item.ref.branchName}`;
			const matchingRemoteBranches = (
				await item.repository.getBranches({ filter: b => b.remote && b.name === remoteBranchName })
			)?.values;
			if (matchingRemoteBranches?.length) return matchingRemoteBranches[0];
		}

		return createReference(remoteBranchName, item.repository.path, {
			refType: 'branch',
			id: getBranchId(item.repository.path, true, remoteBranchName),
			name: remoteBranchName,
			remote: true,
		});
	}

	async getCategorizedItems(
		options?: { force?: boolean; issues?: boolean; prs?: boolean },
		cancellation?: CancellationToken,
	): Promise<FocusItem[]> {
		const enrichedItemsPromise = this.getEnrichedItems({ force: options?.force, cancellation: cancellation });

		if (this.container.git.isDiscoveringRepositories) {
			await this.container.git.isDiscoveringRepositories;
		}

		if (cancellation?.isCancellationRequested) throw new CancellationError();

		const [enrichedItemsResult, /*issuesResult,*/ prsResult] = await Promise.allSettled([
			enrichedItemsPromise,
			// options?.issues !== false
			// 	? this.getIssues({ force: options?.force, cancellation: cancellation })
			// 	: undefined,
			options?.prs !== false
				? this.getPullRequests({ force: options?.force, cancellation: cancellation })
				: undefined,
		]);

		if (cancellation?.isCancellationRequested) throw new CancellationError();

		const enrichedItems = new Map(getSettledValue(enrichedItemsResult)?.map(i => [i.entityId, i]));

		const categorized: FocusItem[] = [];

		// TODO: Since this is all repos we probably should order by repos you are a contributor on (or even filter out one you aren't)

		const prs = getSettledValue(prsResult);
		if (prs != null) {
			outer: for (const pr of prs) {
				if (pr.pullRequest.isDraft) continue;

				const enrichedItem = enrichedItems.get(pr.pullRequest.nodeId!);

				if (pr.reasons.includes('authored')) {
					if (pr.pullRequest.statusCheckRollupState === PullRequestStatusCheckRollupState.Failed) {
						categorized.push(createFocusItem('failed-checks', pr, enrichedItem));
						continue;
					}

					const viewerHasMergeAccess =
						pr.pullRequest.viewerCanUpdate &&
						pr.pullRequest.repository.accessLevel != null &&
						pr.pullRequest.repository.accessLevel >= RepositoryAccessLevel.Write;

					switch (pr.pullRequest.mergeableState) {
						case PullRequestMergeableState.Mergeable:
							switch (pr.pullRequest.reviewDecision) {
								case PullRequestReviewDecision.Approved:
									if (viewerHasMergeAccess) {
										categorized.push(createFocusItem('mergeable', pr, enrichedItem));
									} // TODO: should it be on in any group if you can't merge? maybe need to check if you are a contributor to the repo or something
									continue outer;
								case PullRequestReviewDecision.ChangesRequested:
									categorized.push(createFocusItem('changes-requested', pr, enrichedItem));
									continue outer;
								case PullRequestReviewDecision.ReviewRequired:
									categorized.push(createFocusItem('waiting-for-review', pr, enrichedItem));
									continue outer;
								case undefined:
									if (pr.pullRequest.reviewRequests?.length) {
										categorized.push(createFocusItem('waiting-for-review', pr, enrichedItem));
										continue outer;
									}
									break;
							}
							break;
						case PullRequestMergeableState.Conflicting:
							if (
								pr.pullRequest.reviewDecision === PullRequestReviewDecision.Approved &&
								viewerHasMergeAccess
							) {
								categorized.push(createFocusItem('mergeable-conflicts', pr, enrichedItem));
							} else {
								categorized.push(createFocusItem('conflicts', pr, enrichedItem));
							}
							continue outer;
					}
				}

				if (pr.reasons.includes('review-requested')) {
					// Skip adding if there are failed CI checks
					if (pr.pullRequest.statusCheckRollupState === PullRequestStatusCheckRollupState.Failed) continue;

					categorized.push(createFocusItem('needs-review', pr, enrichedItem));
					continue;
				}
			}
		}

		// const issues = getSettledValue(issuesResult);
		// if (issues != null) {
		// 	for (const issue of issues.splice(0, 3)) {
		// 		let next = false;

		// 		const enrichedItem = enrichedItems.get(issue.issue.nodeId!);
		// 		if (enrichedItem != null) {
		// 			switch (enrichedItem.type) {
		// 				case 'pin':
		// 					addItemToGroup(grouped, 'Pinned', issue);
		// 					next = true;
		// 					break;
		// 				case 'snooze':
		// 					addItemToGroup(grouped, 'Snoozed', issue);
		// 					next = true;
		// 					break;
		// 			}

		// 			if (next) continue;
		// 		}

		// 		if (issue.reasons.includes('assigned')) {
		// 			addItemToGroup(grouped, 'In Progress', issue);
		// 			continue;
		// 		}
		// 	}
		// }

		// // Sort the grouped map by the order of the Groups array
		// const sorted = new Map<FocusActionCategory, FocusItem[]>();
		// for (const group of actionCategories) {
		// 	const items = categorized.get(group);
		// 	if (items == null) continue;

		// 	sorted.set(
		// 		group,
		// 		items.sort((a, b) => (a.pinned ? -1 : 1) - (b.pinned ? -1 : 1) || b.sortTime - a.sortTime),
		// 	);
		// }

		this._onDidRefresh.fire({ items: categorized });
		return categorized;
	}
}

function createFocusItem(
	category: FocusActionCategory,
	item: SearchedPullRequest | SearchedIssue,
	enriched?: EnrichedItem,
): FocusItem {
	return 'pullRequest' in item
		? {
				type: 'pullRequest',
				id: item.pullRequest.id,
				uniqueId: item.pullRequest.nodeId!,
				title: item.pullRequest.title,
				date: item.pullRequest.date,
				author: item.pullRequest.author.name,
				avatarUrl: item.pullRequest.author.avatarUrl,
				repoAndOwner: `${item.pullRequest.repository.owner}/${item.pullRequest.repository.repo}`,
				url: item.pullRequest.url,

				enrichable: {
					type: 'pr',
					id: item.pullRequest.nodeId!,
					url: item.pullRequest.url,
					provider: 'github',
				},
				enriched: enriched,

				actionableCategory: category,
				suggestedActions: prActionsMap.get(category)!,

				pinned: enriched?.type === 'pin',
				snoozed: enriched?.type === 'snooze',
				sortTime: item.pullRequest.date.getTime(),
				repositoryIdentity: {
					remote: { url: item.pullRequest.refs?.head?.url },
					name: item.pullRequest.repository.repo,
					provider: {
						// TODO: fix this typing, set according to item
						id: 'github' as GkProviderId,
						repoDomain: item.pullRequest.repository.owner,
						repoName: item.pullRequest.repository.repo,
					},
				},
				ref:
					item.pullRequest.refs?.head != null
						? {
								branchName: item.pullRequest.refs.head.branch,
								sha: item.pullRequest.refs.head.sha,
								remoteName: item.pullRequest.refs.head.owner,
						  }
						: undefined,
		  }
		: {
				type: 'issue',
				id: item.issue.id,
				uniqueId: item.issue.nodeId!,
				title: item.issue.title,
				date: item.issue.updatedDate,
				author: item.issue.author.name,
				avatarUrl: item.issue.author.avatarUrl,
				repoAndOwner: `${item.issue.repository.owner}/${item.issue.repository.repo}`,
				url: item.issue.url,

				enrichable: {
					type: 'issue',
					id: item.issue.nodeId!,
					url: item.issue.url,
					provider: 'github',
				},
				enriched: enriched,

				actionableCategory: category,
				suggestedActions: [],

				pinned: enriched?.type === 'pin',
				snoozed: enriched?.type === 'snooze',
				sortTime: item.issue.updatedDate.getTime(),
				repositoryIdentity: {
					name: item.issue.repository.repo,
					provider: {
						// TODO: fix this typing, set according to item
						id: 'github' as GkProviderId,
						repoDomain: item.issue.repository.owner,
						repoName: item.issue.repository.repo,
					},
				},
		  };
}

export function groupAndSortFocusItems(items: FocusItem[]) {
	const grouped = new Map<FocusGroup, FocusItem[]>(focusGroups.map(g => [g, []]));

	sortFocusItems(items);

	for (const item of items) {
		if (item.pinned) {
			grouped.get('pinned')?.push(item);
		} else if (item.snoozed) {
			grouped.get('snoozed')?.push(item);
		}

		const group = focusCategoryToGroupMap.get(item.actionableCategory);
		if (group == null) continue;

		grouped.get(group)?.push(item);
	}

	return grouped;
}

export function sortFocusItems(items: FocusItem[]) {
	return items.sort(
		(a, b) =>
			(a.pinned ? -1 : 1) - (b.pinned ? -1 : 1) ||
			focusActionCategories.indexOf(b.actionableCategory) - focusActionCategories.indexOf(a.actionableCategory) ||
			b.sortTime - a.sortTime,
	);
}

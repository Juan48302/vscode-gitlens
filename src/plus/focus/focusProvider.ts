import type { CancellationToken } from 'vscode';
import { Disposable, EventEmitter } from 'vscode';
import type { Container } from '../../container';
import { CancellationError } from '../../errors';
import type { SearchedIssue } from '../../git/models/issue';
import { RepositoryAccessLevel } from '../../git/models/issue';
import type { SearchedPullRequest } from '../../git/models/pullRequest';
import {
	PullRequestMergeableState,
	PullRequestReviewDecision,
	PullRequestStatusCheckRollupState,
} from '../../git/models/pullRequest';
import { getSettledValue } from '../../system/promise';
import { HostedProviderId, SelfHostedProviderId } from '../integrations/providers/models';
import type { EnrichableItem, EnrichedItem } from './enrichmentService';
import { FocusIndicator } from './focusIndicator';

export const actionGroups = [
	'mergeable',
	'mergeable-conflicts',
	'failed-checks',
	'needs-review',
	'conflicts',
	'changes-requested',
	'waiting-for-review',
] as const;

export type FocusActionGroup = (typeof actionGroups)[number];

export type FocusAction = 'open' | 'merge' | 'review' | 'switch' | 'change-reviewers' | 'nudge' | 'decline-review';

const prActionsMap = new Map<FocusActionGroup, FocusAction[]>([
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

	actionGroup: FocusActionGroup;
	suggestedActions: FocusAction[];
	pinned: boolean;
	snoozed: boolean;
	sortTime: number;
};

export interface FocusRefreshEvent {
	groupedItems: Map<FocusActionGroup, FocusItem[]>;
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
	private _focusIndicator: FocusIndicator;

	constructor(private readonly container: Container) {
		this._disposable = Disposable.from(
			(this._focusIndicator = new FocusIndicator(container, this)),
			// configuration.onDidChange(this.onConfigurationChanged, this),
		);
	}

	dispose() {
		this._focusIndicator?.dispose();
		this._disposable.dispose();
	}

	private _issues: Promise<SearchedIssue[] | undefined> | undefined;
	private getIssues(options?: { cancellation?: CancellationToken; force?: boolean }) {
		if (options?.force || this._issues == null) {
			this._issues = this.container.integrations.getMyIssues(
				[HostedProviderId.GitHub, SelfHostedProviderId.GitHubEnterprise],
				options?.cancellation,
			);
		}

		return this._issues;
	}

	private _prs: Promise<SearchedPullRequest[] | undefined> | undefined;
	private async getPullRequests(options?: { cancellation?: CancellationToken; force?: boolean }) {
		if (options?.force || this._prs == null) {
			this._prs = this.container.integrations.getMyPullRequests(
				[HostedProviderId.GitHub, SelfHostedProviderId.GitHubEnterprise],
				options?.cancellation,
			);
		}

		return this._prs;
	}

	private _enrichedItems: Promise<EnrichedItem[] | undefined> | undefined;
	private async getEnrichedItems(options?: { cancellation?: CancellationToken; force?: boolean }) {
		if (options?.force || this._enrichedItems == null) {
			this._enrichedItems = this.container.enrichments.get(undefined, options?.cancellation);
		}

		return this._enrichedItems;
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
		this._onDidChange.fire();
	}

	async unpin(item: FocusItem) {
		item.pinned = false;
		this._onDidChange.fire();

		await this.container.enrichments.pinItem(item.enrichable);
		this._onDidChange.fire();
	}

	async snooze(item: FocusItem) {
		item.snoozed = true;
		this._onDidChange.fire();

		await this.container.enrichments.snoozeItem(item.enrichable);
		this._onDidChange.fire();
	}

	async unsnooze(item: FocusItem) {
		item.snoozed = false;
		this._onDidChange.fire();

		await this.container.enrichments.snoozeItem(item.enrichable);
		this._onDidChange.fire();
	}

	async getRankedAndGroupedItems(
		options?: { force?: boolean; issues?: boolean; prs?: boolean },
		cancellation?: CancellationToken,
	): Promise<Map<FocusActionGroup, FocusItem[]>> {
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

		const grouped = new Map<FocusActionGroup, FocusItem[]>();

		// TODO: Since this is all repos we probably should order by repos you are a contributor on (or even filter out one you aren't)

		const prs = getSettledValue(prsResult);
		if (prs != null) {
			for (const pr of prs) {
				if (pr.pullRequest.isDraft) continue;

				let next = false;

				const enrichedItem = enrichedItems.get(pr.pullRequest.nodeId!);
				if (enrichedItem?.type === 'snooze') continue;

				if (pr.reasons.includes('authored')) {
					if (pr.pullRequest.statusCheckRollupState === PullRequestStatusCheckRollupState.Failed) {
						addItemToGroup(grouped, 'failed-checks', pr, enrichedItem);
						continue;
					}

					switch (pr.pullRequest.mergeableState) {
						case PullRequestMergeableState.Mergeable:
							switch (pr.pullRequest.reviewDecision) {
								case PullRequestReviewDecision.Approved:
									next = true;
									if (
										pr.pullRequest.viewerCanUpdate &&
										pr.pullRequest.repository.accessLevel != null &&
										pr.pullRequest.repository.accessLevel >= RepositoryAccessLevel.Write
									) {
										addItemToGroup(grouped, 'mergeable', pr, enrichedItem);
									} // TODO: should it be on in any group if you can't merge? maybe need to check if you are a contributor to the repo or something
									break;
								case PullRequestReviewDecision.ChangesRequested:
									next = true;
									addItemToGroup(grouped, 'changes-requested', pr, enrichedItem);
									break;
								case PullRequestReviewDecision.ReviewRequired:
									next = true;
									addItemToGroup(grouped, 'needs-review', pr, enrichedItem);
									break;
							}
							break;
						case PullRequestMergeableState.Conflicting:
							next = true;
							if (pr.pullRequest.reviewDecision === PullRequestReviewDecision.Approved) {
								addItemToGroup(grouped, 'mergeable-conflicts', pr, enrichedItem);
							} else {
								addItemToGroup(grouped, 'conflicts', pr, enrichedItem);
							}
							break;
					}

					if (next) continue;
				}

				if (pr.reasons.includes('review-requested')) {
					// Skip adding if there are failed CI checks
					if (pr.pullRequest.statusCheckRollupState === PullRequestStatusCheckRollupState.Failed) continue;

					addItemToGroup(grouped, 'needs-review', pr, enrichedItem);
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

		// Sort the grouped map by the order of the Groups array
		const sorted = new Map<FocusActionGroup, FocusItem[]>();
		for (const group of actionGroups) {
			const items = grouped.get(group);
			if (items == null) continue;

			sorted.set(
				group,
				items.sort((a, b) => (b.pinned ? -1 : 1) - (a.pinned ? -1 : 1) || b.sortTime - a.sortTime),
			);
		}

		this._onDidRefresh.fire({ groupedItems: sorted });
		return sorted;
	}
}

function addItemToGroup(
	grouped: Map<FocusActionGroup, FocusItem[]>,
	group: FocusActionGroup,
	item: SearchedPullRequest | SearchedIssue,
	enriched?: EnrichedItem,
) {
	let items = grouped.get(group);
	if (items == null) {
		items = [];
		grouped.set(group, items);
	}
	items.push(
		'pullRequest' in item
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

					actionGroup: group,
					suggestedActions: prActionsMap.get(group)!,
					pinned: enriched?.type === 'pin',
					snoozed: enriched?.type === 'snooze',
					sortTime: item.pullRequest.date.getTime(),
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

					actionGroup: group,
					suggestedActions: [], //issueActionsMap.get(group)!,
					pinned: enriched?.type === 'pin',
					snoozed: enriched?.type === 'snooze',
					sortTime: item.issue.updatedDate.getTime(),
			  },
	);
}

import { ThemeIcon, Uri } from 'vscode';
import { getSteps } from '../../commands/gitCommands.utils';
import type {
	PartialStepState,
	StepGenerator,
	StepResultGenerator,
	StepSelection,
	StepState,
} from '../../commands/quickCommand';
import {
	canPickStepContinue,
	createPickStep,
	endSteps,
	QuickCommand,
	StepResultBreak,
} from '../../commands/quickCommand';
import {
	MergeQuickInputButton,
	PinQuickInputButton,
	RefreshQuickInputButton,
	SnoozeQuickInputButton,
	UnpinQuickInputButton,
	UnsnoozeQuickInputButton,
} from '../../commands/quickCommand.buttons';
import type { Container } from '../../container';
import type { QuickPickItemOfT } from '../../quickpicks/items/common';
import { createQuickPickItemOfT, createQuickPickSeparator } from '../../quickpicks/items/common';
import type { DirectiveQuickPickItem } from '../../quickpicks/items/directive';
import { createDirectiveQuickPickItem, Directive } from '../../quickpicks/items/directive';
import { command } from '../../system/command';
import { fromNow } from '../../system/date';
import { interpolate } from '../../system/string';
import { openUrl } from '../../system/utils';
import { HostedProviderId } from '../integrations/providers/models';
import type { FocusAction, FocusActionCategory, FocusGroup, FocusItem } from './focusProvider';
import { groupAndSortFocusItems } from './focusProvider';

const actionGroupMap = new Map<FocusActionCategory, string[]>([
	['mergeable', ['Ready to Merge', 'Ready to merge']],
	['mergeable-conflicts', ['Resolve Conflicts', 'You need to resolve merge conflicts, before this can be merged']],
	['failed-checks', ['Failed Checks', 'You need to resolve the failing checks']],
	['conflicts', ['Resolve Conflicts', 'You need to resolve merge conflicts']],
	['needs-review', ['Needs Your Review', `\${author} requested your review`]],
	['changes-requested', ['Changes Requested', 'Reviewers requested changes before this can be merged']],
	['waiting-for-review', ['Waiting for Review', 'Waiting for reviewers to approve this pull request']],
]);

const groupMap = new Map<FocusGroup, [string, ThemeIcon | undefined]>([
	['pinned', ['Pinned', new ThemeIcon('pinned')]],
	['mergeable', ['Ready to Merge', new ThemeIcon('rocket')]],
	['blocked', ['Blocked', new ThemeIcon('error')]], //bracket-error
	['follow-up', ['Requires Follow-up', new ThemeIcon('report')]],
	['needs-attention', ['Needs Your Attention', new ThemeIcon('bell-dot')]], //comment-unresolved
	['needs-review', ['Needs Your Review', new ThemeIcon('comment-draft')]], // feedback
	['waiting-for-review', ['Waiting for Review', new ThemeIcon('gitlens-clock')]],
	['snoozed', ['Snoozed', new ThemeIcon('bell-slash')]],
]);

export interface FocusItemQuickPickItem extends QuickPickItemOfT<FocusItem> {}

interface Context {
	items: FocusItem[];
	title: string;
	collapsed: Map<FocusGroup, boolean>;
}

interface State {
	item?: FocusItem;
	action?: FocusAction;
}

export interface FocusCommandArgs {
	readonly command: 'focus';
	confirm?: boolean;
	state?: Partial<State>;
}

type FocusStepState<T extends State = State> = RequireSome<StepState<T>, 'item'>;

function assertsFocusStepState(state: StepState<State>): asserts state is FocusStepState {
	if (state.item != null) return;

	debugger;
	throw new Error('Missing item');
}

@command()
export class FocusCommand extends QuickCommand<State> {
	constructor(container: Container, args?: FocusCommandArgs) {
		super(container, 'focus', 'focus', 'Focus', { description: 'focus on a pull request or issue' });

		const counter = 0;

		this.initialState = {
			counter: counter,
			confirm: args?.confirm,
			...args?.state,
		};
	}

	protected async *steps(state: PartialStepState<State>): StepGenerator {
		if (this.container.git.isDiscoveringRepositories) {
			await this.container.git.isDiscoveringRepositories;
		}

		const context: Context = {
			items: await this.container.focus.getCategorizedItems(),
			title: this.title,
			collapsed: new Map<FocusGroup, boolean>([['snoozed', true]]),
		};

		while (this.canStepsContinue(state)) {
			context.title = this.title;

			if (state.counter < 1 || state.item == null) {
				const result = yield* this.pickFocusItemStep(state, context, {
					picked: state.item?.id,
				});
				if (result === StepResultBreak) continue;

				state.item = result;
			}

			assertsFocusStepState(state);

			if (this.confirm(state.confirm)) {
				const result = yield* this.confirmStep(state, context);
				if (result === StepResultBreak) continue;

				state.action = result;
			}

			switch (state.action) {
				case 'merge': {
					// TODO: Move all the action logic to a Focus Provider fn and use eventing to refresh.
					if (state.item.uniqueId == null || state.item.ref?.sha == null) break;
					// TODO: This should get the provider from the item.
					const github = this.container.integrations.get(HostedProviderId.GitHub);
					await github.mergePullRequest({ id: state.item.uniqueId, headRefSha: state.item.ref.sha });
					void this.container.focus.getCategorizedItems({ force: true });
					break;
				}
				case 'open':
					void openUrl(state.item.url);
					break;
				case 'review':
				case 'switch': {
					// TODO
					const repo = await this.container.focus.locateItemRepository(state.item, {
						openIfNeeded: true,
						prompt: true,
						keepOpen: true,
					});
					if (repo == null) break;
					state.item.repository = repo;
					const ref = await this.container.focus.getItemBranchRef(state.item);
					// TODO: need to find matching local branches with the ref as their upstream, and:
					// If none, pass in the remote ref to the switch,
					// If one, pass in the local branch to the switch,
					// If multiple, need to update the switch to filter down to just those branches as choices
					// const localBranches = ref == null ? undefined : await repo.getBranches({ filter: b => b.upstream?.name === ref.ref && b.remote === false && b.name === state.item.ref?.branchName });
					yield* getSteps(
						this.container,
						{
							command: 'switch',
							state: {
								repos: [repo],
								reference: ref,
							},
						},
						this.pickedVia,
					);
					break;
				}
				// case 'change-reviewers':
				// 	await this.container.focus.changeReviewers(state.item);
				// 	break;
				// case 'decline-review':
				// 	await this.container.focus.declineReview(state.item);
				// 	break;
				// case 'nudge':
				// 	await this.container.focus.nudge(state.item);
				// 	break;
			}

			endSteps(state);
		}

		return state.counter < 0 ? StepResultBreak : undefined;
	}

	private *pickFocusItemStep(
		state: StepState<State>,
		context: Context,
		{ picked }: { picked?: string },
	): StepResultGenerator<FocusItem> {
		function getItems(categorizedItems: FocusItem[]) {
			const items: (FocusItemQuickPickItem | DirectiveQuickPickItem)[] = [];

			if (categorizedItems?.length) {
				const uiGroups = groupAndSortFocusItems(categorizedItems);
				for (const [ui, groupItems] of uiGroups) {
					if (!groupItems.length) continue;

					items.push(
						createQuickPickSeparator(groupItems.length ? groupItems.length.toString() : undefined),
						createDirectiveQuickPickItem(Directive.Reload, false, {
							label: `${groupMap.get(ui)![0]?.toUpperCase()}\u00a0$(${
								context.collapsed.get(ui) ? 'chevron-down' : 'chevron-up'
							})`, //'\u00a0',
							//detail: groupMap.get(group)?.[0].toUpperCase(),
							iconPath: groupMap.get(ui)![1],
							onDidSelect: () => {
								context.collapsed.set(ui, !context.collapsed.get(ui));
							},
						}),
					);

					if (context.collapsed.get(ui)) continue;

					items.push(
						...groupItems.map(i => {
							const buttons = [];

							if (i.actionableCategory === 'mergeable') {
								buttons.push(
									MergeQuickInputButton,
									i.pinned ? UnpinQuickInputButton : PinQuickInputButton,
								);
							} else if (i.pinned) {
								buttons.push(UnpinQuickInputButton);
							} else if (i.snoozed) {
								buttons.push(UnsnoozeQuickInputButton);
							} else {
								buttons.push(PinQuickInputButton, SnoozeQuickInputButton);
							}

							return {
								label: i.title,
								// description: `${i.repoAndOwner}#${i.id}, by @${i.author}`,
								description: `#${i.id}`,
								detail: `${actionGroupMap.get(i.actionableCategory)![0]} \u2022  ${fromNow(
									i.date,
								)} by @${i.author} \u2022 ${i.repoAndOwner}`,

								buttons: buttons,
								iconPath: Uri.parse(i.avatarUrl),
								item: i,
								picked: i.id === picked,
							};
						}),
					);
				}
			}

			return items;
		}

		const items = getItems(context.items);

		const step = createPickStep({
			title: context.title,
			placeholder: !items.length ? 'All done! Take a vacation' : 'Choose an item to focus on',
			matchOnDetail: true,
			ignoreFocusOut: true,
			items: !items.length ? [createDirectiveQuickPickItem(Directive.Cancel, undefined, { label: 'OK' })] : items,
			buttons: [RefreshQuickInputButton],
			// onDidChangeValue: async (quickpick, value) => {},
			onDidClickButton: async (quickpick, button) => {
				if (button === RefreshQuickInputButton) {
					quickpick.busy = true;

					try {
						context.items = await this.container.focus.getCategorizedItems({ force: true });
						const items = getItems(context.items);

						quickpick.placeholder = !items.length
							? 'All done! Take a vacation'
							: 'Choose an item to focus on';
						quickpick.items = items;
					} finally {
						quickpick.busy = false;
					}
				}
			},

			onDidClickItemButton: async (quickpick, button, { item }) => {
				switch (button) {
					case SnoozeQuickInputButton:
						await this.container.focus.snooze(item);
						break;

					case UnsnoozeQuickInputButton:
						await this.container.focus.unsnooze(item);
						break;

					case PinQuickInputButton:
						await this.container.focus.pin(item);
						break;

					case UnpinQuickInputButton:
						await this.container.focus.unpin(item);
						break;
				}

				quickpick.busy = true;

				try {
					context.items = await this.container.focus.getCategorizedItems();
					const items = getItems(context.items);

					quickpick.placeholder = !items.length ? 'All done! Take a vacation' : 'Choose an item to focus on';
					quickpick.items = items;
				} finally {
					quickpick.busy = false;
				}
			},
		});

		const selection: StepSelection<typeof step> = yield step;
		return canPickStepContinue(step, state, selection) ? selection[0].item : StepResultBreak;
	}

	private *confirmStep(state: FocusStepState, _context: Context): StepResultGenerator<FocusAction> {
		const confirmations: (QuickPickItemOfT<FocusAction> | DirectiveQuickPickItem)[] = [
			createDirectiveQuickPickItem(Directive.Noop, false, {
				label: state.item.title,
				description: `${state.item.repoAndOwner}#${state.item.id} \u2022 ${fromNow(state.item.date)}`,
				detail: interpolate(actionGroupMap.get(state.item.actionableCategory)![1], {
					author: state.item.author,
				}),
				iconPath: Uri.parse(state.item.avatarUrl),
			}),
			createQuickPickSeparator(),
			createDirectiveQuickPickItem(Directive.Noop, false, {
				label: '',
			}),
		];

		for (const action of state.item.suggestedActions) {
			switch (action) {
				case 'merge':
					confirmations.push(
						createQuickPickItemOfT(
							{
								label: 'Merge',
								detail: 'Will merge the pull request',
							},
							action,
						),
					);
					break;
				case 'open':
					confirmations.push(
						createQuickPickItemOfT(
							{
								label: 'Open on GitHub',
							},
							action,
						),
					);
					break;
				case 'review':
					confirmations.push(
						createQuickPickItemOfT(
							{
								label: 'Start Review',
								detail: 'Will checkout a branch or worktree to review this pull request',
							},
							action,
						),
					);
					break;
				case 'switch':
					confirmations.push(
						createQuickPickItemOfT(
							{
								label: 'Switch to Branch or Worktree',
								detail: 'Will checkout the branch or worktree for this pull request',
							},
							action,
						),
					);
					break;
				case 'change-reviewers':
					confirmations.push(
						createQuickPickItemOfT(
							{
								label: 'Change Reviewers',
								detail: 'Will change the reviewers for this pull request',
							},
							action,
						),
					);
					break;
				case 'decline-review':
					confirmations.push(
						createQuickPickItemOfT(
							{
								label: 'Decline Review',
								detail: 'Will decline the review for this pull request',
							},
							action,
						),
					);
					break;
				case 'nudge':
					confirmations.push(
						createQuickPickItemOfT(
							{
								label: 'Nudge',
								detail: 'Will nudge the reviewers on this pull request',
							},
							action,
						),
					);
					break;
			}
		}

		const step = this.createConfirmStep(
			`Focus on ${state.item.repoAndOwner}#${state.item.id}`,
			confirmations,
			undefined,
			{ placeholder: 'Choose an action to perform' },
		);

		const selection: StepSelection<typeof step> = yield step;
		return canPickStepContinue(step, state, selection) ? selection[0].item : StepResultBreak;
	}
}

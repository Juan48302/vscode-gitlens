import { Uri } from 'vscode';
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
import { groupByMap } from '../../system/iterable';
import { interpolate } from '../../system/string';
import { openUrl } from '../../system/utils';
import type { FocusAction, FocusActionGroup, FocusItem } from './focusProvider';

export const groups = ['mergeable', 'needs-attention', 'needs-review', 'waiting-for-review'] as const;

export type FocusGroup = (typeof groups)[number];

const actionGroupToGroupMap = new Map<FocusActionGroup, FocusGroup>([
	['mergeable', 'mergeable'],
	['mergeable-conflicts', 'needs-attention'],
	['failed-checks', 'needs-attention'],
	['conflicts', 'needs-attention'],
	['needs-review', 'needs-review'],
	['changes-requested', 'needs-attention'],
	['waiting-for-review', 'waiting-for-review'],
]);

const groupMap = new Map<FocusGroup, string>([
	['mergeable', 'Ready to Merge'],
	['needs-attention', 'Needs Your Attention'],
	['needs-review', 'Needs Your Review'],
	['waiting-for-review', 'Waiting for Review'],
]);

const actionGroupMap = new Map<FocusActionGroup, string[]>([
	['mergeable', ['Ready to Merge', 'Ready to merge']],
	['failed-checks', ['Failed Checks', 'You need to resolve the failing checks']],
	['conflicts', ['Resolve Conflicts', 'You need to resolve merge conflicts, before this can be merged']],
	['needs-review', ['Needs Your Review', `\${author} requested your review`]],
	['changes-requested', ['Changes Requested', 'Reviewers requested changes before this can be merged']],
	['waiting-for-review', ['Waiting for Review', 'Waiting for reviewers to approve this pull request']],
]);

export interface FocusItemQuickPickItem extends QuickPickItemOfT<FocusItem> {}

interface Context {
	items: Map<FocusActionGroup, FocusItem[]>;
	title: string;
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
			items: await this.container.focus.getRankedAndGroupedItems(),
			title: this.title,
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
				case 'merge':
					// await this.container.focus.merge(state.item);
					break;
				case 'open':
					void openUrl(state.item.url);
					break;
				case 'review':
				case 'switch': {
					// TODO
					yield* getSteps(
						this.container,
						{
							command: 'switch',
							// state: {
							// 	repos: [state.item.repoAndOwner],
							// 	reference: state.item.ref,
							// },
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
		function getItems(groupedItems: Map<FocusActionGroup, FocusItem[]>) {
			const items: (FocusItemQuickPickItem | DirectiveQuickPickItem)[] = [];

			if (groupedItems?.size) {
				let uiGroups = groupByMap(groupedItems, ([group]) => actionGroupToGroupMap.get(group));
				uiGroups = new Map([...uiGroups].sort((a, b) => groups.indexOf(a[0]!) - groups.indexOf(b[0]!)));

				for (const [ui, groupArray] of uiGroups) {
					for (const [group, groupItems] of groupArray) {
						if (!groupItems.length) continue;

						items.push(
							createQuickPickSeparator(),
							createDirectiveQuickPickItem(Directive.Noop, false, {
								label: groupMap.get(ui!)?.toUpperCase(), //'\u00a0',
								//detail: groupMap.get(group)?.[0].toUpperCase(),
							}),
							// createQuickPickSeparator(),
							...groupItems.map(i => {
								const buttons = [];

								if (group === 'mergeable') {
									buttons.push(
										MergeQuickInputButton,
										i.enriched?.type === 'pin' ? UnpinQuickInputButton : PinQuickInputButton,
									);
								} else if (i.enriched?.type === 'pin') {
									buttons.push(UnpinQuickInputButton);
								} else if (i.enriched?.type === 'snooze') {
									buttons.push(UnsnoozeQuickInputButton);
								} else {
									buttons.push(PinQuickInputButton, SnoozeQuickInputButton);
								}

								return {
									label: i.title,
									// description: `${i.repoAndOwner}#${i.id}, by @${i.author}`,
									description: `#${i.id}`,
									detail: `${actionGroupMap.get(i.actionGroup)![0]} \u2022  ${fromNow(i.date)} by @${
										i.author
									} \u2022 ${i.repoAndOwner}`,

									buttons: buttons,
									iconPath: Uri.parse(i.avatarUrl),
									item: i,
									picked: i.id === picked,
								};
							}),
						);
					}
				}
			}

			return items;
		}

		const items = getItems(context.items);

		const step = createPickStep({
			title: context.title,
			placeholder: !items.length ? 'All done! Take a vacation' : 'Choose an item to focus on',
			matchOnDetail: true,
			items: !items.length ? [createDirectiveQuickPickItem(Directive.Cancel, undefined, { label: 'OK' })] : items,
			buttons: [RefreshQuickInputButton],
			onDidClickButton: async (quickpick, button) => {
				if (button === RefreshQuickInputButton) {
					quickpick.busy = true;

					try {
						context.items = await this.container.focus.getRankedAndGroupedItems({ force: true });
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
				detail: interpolate(actionGroupMap.get(state.item.actionGroup)![1], { author: state.item.author }),
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

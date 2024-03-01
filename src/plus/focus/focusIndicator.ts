import type { ConfigurationChangeEvent, StatusBarItem, ThemeColor } from 'vscode';
import { Disposable, MarkdownString, StatusBarAlignment, window } from 'vscode';
import type { Container } from '../../container';
import { configuration } from '../../system/configuration';
import { groupByMap } from '../../system/iterable';
import { pluralize } from '../../system/string';
import type { FocusItem, FocusProvider, FocusRefreshEvent } from './focusProvider';
import { focusGroups, groupAndSortFocusItems } from './focusProvider';

export class FocusIndicator implements Disposable {
	private readonly _disposable: Disposable;

	private _statusBarFocus: StatusBarItem | undefined;

	private _refreshTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly container: Container,
		private readonly focus: FocusProvider,
	) {
		this._disposable = Disposable.from(
			focus.onDidRefresh(this.onFocusRefreshed, this),
			configuration.onDidChange(this.onConfigurationChanged, this),
		);
		this.onReady();
	}

	dispose() {
		this.clearRefreshTimer();
		this._statusBarFocus?.dispose();
		this._statusBarFocus = undefined!;
		this._disposable.dispose();
	}

	private onConfigurationChanged(e: ConfigurationChangeEvent) {
		if (!configuration.changed(e, 'focus.experimental.indicators')) return;

		if (configuration.changed(e, 'focus.experimental.indicators.openQuickFocus')) {
			this.updateStatusBarFocusCommand();
		}

		if (configuration.changed(e, 'focus.experimental.indicators.refreshRate')) {
			this.startRefreshTimer();
		}
	}

	private onFocusRefreshed(e: FocusRefreshEvent) {
		if (this._statusBarFocus == null) return;

		this.updateStatusBar(this._statusBarFocus, e.items);
	}

	private onReady(): void {
		if (!configuration.get('focus.experimental.indicators.enabled')) {
			return;
		}

		this._statusBarFocus = window.createStatusBarItem('gitlens.focus', StatusBarAlignment.Left, 10000 - 2);
		this._statusBarFocus.name = 'GitLens Focus';
		this._statusBarFocus.text = '$(target)';
		this._statusBarFocus.tooltip = 'Loading...';
		this.updateStatusBarFocusCommand();
		this._statusBarFocus.show();
		this.clearRefreshTimer();
		setTimeout(() => this.startRefreshTimer(), 5000);
	}

	private updateStatusBarFocusCommand() {
		if (this._statusBarFocus == null) return;

		this._statusBarFocus.command = configuration.get('focus.experimental.indicators.openQuickFocus')
			? 'gitlens.quickFocus'
			: 'gitlens.showFocusPage';
	}

	private startRefreshTimer() {
		const refreshInterval = configuration.get('focus.experimental.indicators.refreshRate') * 1000 * 60;
		let refreshNow = true;
		if (this._refreshTimer != null) {
			clearInterval(this._refreshTimer);
			refreshNow = false;
		}

		if (refreshInterval <= 0) return;

		if (refreshNow) {
			void this.focus.getCategorizedItems({ force: true });
		}

		this._refreshTimer = setInterval(() => {
			void this.focus.getCategorizedItems({ force: true });
		}, refreshInterval);
	}

	private clearRefreshTimer() {
		if (this._refreshTimer != null) {
			clearInterval(this._refreshTimer);
			this._refreshTimer = undefined;
		}
	}

	private updateStatusBar(statusBarFocus: StatusBarItem, categorizedItems: FocusItem[]) {
		let color: string | ThemeColor | undefined = undefined;
		let topItem: FocusItem | undefined;

		const groupedItems = groupAndSortFocusItems(categorizedItems);
		if (!groupedItems?.size) {
			statusBarFocus.tooltip = 'You are all caught up!';
		} else {
			statusBarFocus.tooltip = new MarkdownString('', true);
			statusBarFocus.tooltip.supportHtml = true;

			for (const group of focusGroups) {
				const items = groupedItems.get(group);
				if (items?.length) {
					if (statusBarFocus.tooltip.value.length > 0) {
						statusBarFocus.tooltip.appendMarkdown(`\n\n---\n\n`);
					}
					switch (group) {
						case 'mergeable':
							statusBarFocus.tooltip.appendMarkdown(
								`<span style="color:#00FF00;">$(circle-filled)</span> You have ${pluralize(
									'pull request',
									items.length,
								)} that can be merged.`,
							);

							color = '#00FF00';
							topItem ??= items[0];
							break;
						case 'blocked': {
							const action = groupByMap(items, i =>
								i.actionableCategory === 'failed-checks' ||
								i.actionableCategory === 'mergeable-conflicts' ||
								i.actionableCategory === 'conflicts'
									? i.actionableCategory
									: 'blocked',
							);

							let actionGroupItems = action.get('failed-checks');
							if (actionGroupItems?.length) {
								const message =
									actionGroupItems.length === 1
										? `You have a pull request that has failed CI checks.`
										: `You have ${actionGroupItems.length} pull requests that have failed CI checks.`;
								statusBarFocus.tooltip.appendMarkdown(
									`<span style="color:#FF0000;">$(circle-filled)</span> ${message}`,
								);
							}

							actionGroupItems = action.get('mergeable-conflicts');
							if (actionGroupItems?.length) {
								const message =
									actionGroupItems.length === 1
										? `You have a pull request that can be merged once conflicts are resolved.`
										: `You have ${actionGroupItems.length} pull requests that can be merged once conflicts are resolved.`;

								statusBarFocus.tooltip.appendMarkdown(
									`<span style="color:#FF0000;">$(circle-filled)</span> ${message}`,
								);
							}

							actionGroupItems = action.get('conflicts');
							if (actionGroupItems?.length) {
								const message =
									actionGroupItems.length === 1
										? `You have a pull request that has conflicts.`
										: `You have ${actionGroupItems.length} pull requests that have conflicts.`;

								statusBarFocus.tooltip.appendMarkdown(
									`<span style="color:#FF0000;">$(circle-filled)</span> ${message}`,
								);
							}

							actionGroupItems = action.get('blocked');
							if (actionGroupItems?.length) {
								const message =
									actionGroupItems.length === 1
										? `You have a pull request that needs attention.`
										: `You have ${actionGroupItems.length} pull requests that need attention.`;

								statusBarFocus.tooltip.appendMarkdown(
									`<span style="color:#FF0000;">$(circle-filled)</span> ${message}`,
								);
							}

							color ??= '#FF0000';
							topItem ??= items[0];
							break;
						}
						case 'needs-review':
							statusBarFocus.tooltip.appendMarkdown(
								`<span style="color:#FFFF00;">$(circle-filled)</span> You have ${pluralize(
									'pull request',
									items.length,
								)} that are waiting for your review.`,
							);

							color ??= '#FFFF00';
							break;
						case 'follow-up':
							statusBarFocus.tooltip.appendMarkdown(
								`<span style="color:#FFA500;">$(circle-filled)</span> You have ${pluralize(
									'pull request',
									items.length,
								)} to that have been reviewed but require changes.`,
							);

							color ??= '#FFA500';
							break;
					}
				}
			}
		}

		statusBarFocus.text = topItem ? `$(target) #${topItem.id}` : '$(target)';
		statusBarFocus.color = color;
	}
}

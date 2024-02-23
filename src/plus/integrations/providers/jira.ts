import type { AuthenticationSession, CancellationToken } from 'vscode';
import type { Account } from '../../../git/models/author';
import type { SearchedIssue } from '../../../git/models/issue';
import { filterMap, flatten } from '../../../system/iterable';
import type { IntegrationAuthenticationProviderDescriptor } from '../authentication/integrationAuthentication';
import type { ResourceDescriptor } from '../integration';
import { IssueIntegration } from '../integration';
import { IssueFilter, IssueIntegrationId, providersMetadata, toAccount, toSearchedIssue } from './models';

const metadata = providersMetadata[IssueIntegrationId.Jira];
const authProvider = Object.freeze({ id: metadata.id, scopes: metadata.scopes });

export interface JiraResourceDescriptor extends ResourceDescriptor {
	key: string;
	id: string;
	name: string;
	avatarUrl: string;
}

export interface JiraProjectDescriptor extends ResourceDescriptor {
	key: string;
	name: string;
	resourceId: string;
}

export class JiraIntegration extends IssueIntegration<IssueIntegrationId.Jira> {
	readonly authProvider: IntegrationAuthenticationProviderDescriptor = authProvider;
	readonly id = IssueIntegrationId.Jira;
	protected readonly key = this.id;
	readonly name: string = 'Jira';

	get domain(): string {
		return metadata.domain;
	}

	protected get apiBaseUrl(): string {
		return 'https://api.atlassian.com';
	}

	protected override async getProviderAccountForResource(
		{ accessToken }: AuthenticationSession,
		resource: JiraResourceDescriptor,
	): Promise<Account | undefined> {
		const user = await this.api.getCurrentUserForResource(this.id, resource.id, {
			accessToken: accessToken,
		});

		if (user == null) return undefined;
		return toAccount(user, this);
	}

	protected override async getProviderResourcesForUser({
		accessToken,
	}: AuthenticationSession): Promise<JiraResourceDescriptor[] | undefined> {
		const resources = await this.api.getJiraResourcesForCurrentUser({ accessToken: accessToken });
		return resources != null ? resources.map(r => ({ ...r, key: r.id })) : undefined;
	}

	protected override async getProviderProjectsForResources(
		{ accessToken }: AuthenticationSession,
		resources: JiraResourceDescriptor[],
	): Promise<JiraProjectDescriptor[] | undefined> {
		const jiraProjectBaseDescriptors = await this.api.getJiraProjectsForResources(
			resources.map(r => r.id),
			{ accessToken: accessToken },
		);
		return jiraProjectBaseDescriptors?.map(jiraProjectBaseDescriptor => ({
			...jiraProjectBaseDescriptor,
			key: jiraProjectBaseDescriptor.name,
		}));
	}

	protected override async getProviderIssuesForProject(
		{ accessToken }: AuthenticationSession,
		project: JiraProjectDescriptor,
		options?: { user: string; filters: IssueFilter[] },
	): Promise<SearchedIssue[] | undefined> {
		let results;

		const getSearchedUserIssuesForFilter = async (
			user: string,
			filter: IssueFilter,
		): Promise<SearchedIssue[] | undefined> => {
			const results = await this.api.getIssuesForProject(this.id, project.name, project.resourceId, {
				authorLogin: filter === IssueFilter.Author ? user : undefined,
				assigneeLogins: filter === IssueFilter.Assignee ? [user] : undefined,
				mentionLogin: filter === IssueFilter.Mention ? user : undefined,
				accessToken: accessToken,
			});

			return results
				?.map(issue => toSearchedIssue(issue, this, filter))
				.filter((result): result is SearchedIssue => result !== undefined);
		};

		if (options?.user != null && options.filters.length > 0) {
			const resultsPromise = Promise.allSettled(
				options.filters.map(filter => getSearchedUserIssuesForFilter(options.user, filter)),
			);

			results = [
				...flatten(
					filterMap(await resultsPromise, r =>
						r.status === 'fulfilled' && r.value != null ? r.value : undefined,
					),
				),
			];

			const resultsById = new Map<string, SearchedIssue>();
			for (const result of results) {
				if (resultsById.has(result.issue.id)) {
					const existing = resultsById.get(result.issue.id)!;
					existing.reasons = [...existing.reasons, ...result.reasons];
				} else {
					resultsById.set(result.issue.id, result);
				}
			}

			return [...resultsById.values()];
		}

		results = await this.api.getIssuesForProject(this.id, project.name, project.resourceId, {
			accessToken: accessToken,
		});
		return results
			?.map(issue => toSearchedIssue(issue, this))
			.filter((result): result is SearchedIssue => result !== undefined);
	}

	protected override async searchProviderMyIssues(
		session: AuthenticationSession,
		resources?: JiraResourceDescriptor[],
		_cancellation?: CancellationToken,
	): Promise<SearchedIssue[] | undefined> {
		const myResources = resources ?? (await this.getProviderResourcesForUser(session));
		if (!myResources) return undefined;

		const results: SearchedIssue[] = [];
		for (const resource of myResources) {
			const userLogin = (await this.getProviderAccountForResource(session, resource))?.username;
			const resourceIssues = await this.api.getIssuesForResourceForCurrentUser(this.id, resource.id, {
				accessToken: session.accessToken,
			});
			const formattedIssues = resourceIssues
				?.map(issue => toSearchedIssue(issue, this, undefined, userLogin))
				.filter((result): result is SearchedIssue => result != null);
			if (formattedIssues != null) {
				results.push(...formattedIssues);
			}
		}

		return results;
	}
}

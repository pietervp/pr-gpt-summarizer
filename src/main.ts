import * as openai from 'openai';
import * as core from '@actions/core'
import * as github from '@actions/github'

async function run(): Promise<void> {
  try {

    // store input github token or get it from environment
    const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN;

    // check if inputs are set 
    if (!githubToken) {
      throw new Error('Input github-token is not set, exiting');
    }

    if (!core.getInput('openai-token')) {
      throw new Error('Input openai-token is not set, exiting');
    }

    const octokit = github.getOctokit(githubToken);
    const api = new openai.OpenAIApi(new openai.Configuration({ apiKey: core.getInput('openai-token') }));

    // try different ways to get to pr number
    const prNumber = github.context.payload.pull_request?.number;
    const issueNumber = github.context.payload.issue?.number;
    const number = prNumber || issueNumber;

    if (!number) {
      throw new Error('Could not get pull request number from context, exiting');
    }

    // get the pr body, and parse the previously generated table of commits with their changelog
    const { data: pr } = await octokit.rest.pulls.get({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: number,
    });

    // check if pr is null
    if (!pr) {
      throw new Error('Could not get pull request from GitHub API, exiting');
    }

    var newBody = pr.body ?? "";

    // we hide data in the pr body, so we need to parse it
    // the data is in format <!-- GPT-LOG:<json object> -->
    const logRegex = /<!-- GPT-LOG:(.*) -->/g;
    const logMatch = logRegex.exec(pr.body ?? "");
    const parsedLogs: CommitLog[] = [];

    if (logMatch) {
      // parse the log as a list of CommitLog objects
      const parsed = JSON.parse(logMatch[1]);
      parsedLogs.push(...parsed);
      // remove entire logmatch from the new body so we can replace it later
      newBody = newBody.replace(logMatch[0], "");
    }

    const { data: commits } = await octokit.rest.pulls.listCommits({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: number,
    });

    core.info(`Found ${commits.length} commits in PR`);
    core.info(`Found ${parsedLogs.length} previously parsed commits`);
    
    // filter the commits to only include the ones that are NOT in the parsedLogs
    const filteredCommits = commits.filter((commit) => {
      return !parsedLogs.some((log) => {
        return log.commitHash === commit.sha;
      });
    });

    core.info(`Found ${filteredCommits.length} new commits`);
    core.info(`Generating changelogs for new commits`);

    // for loop over the diff urls
    for (const commitData of filteredCommits) {
      core.info(`----------------------------------------`);
      core.info(`Generating changelog for commit ${commitData.sha}`);
      core.info(`Commit message: ${commitData.commit.message}`);
      core.info(`Commit url: ${commitData.html_url}`);
      
      // download the diff url
      await octokit.rest.repos.getCommit({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        ref: commitData.sha,
        mediaType: {
          format: "diff"
        }
      }).then(async (response) => {

        core.info(`Downloaded diff for commit ${commitData.sha}`);
        
        const patches = response.data.files?.map(file => file.patch);
        const patch = patches?.join("\n");

        core.info(`Parsed diff for commit ${commitData.sha}`);

        // concat all the parsedLogs messages together
        const messages = parsedLogs.map((log) => log.changelog).join("\n");
        const prompt = `Your task is to describe the change in the current commit diff, given the context data of PreviousLogs and Message. Format any class, field or parameter name using backticks. Make sure the most meaningfull changes are mentioned at least once. Try to correlate to the PR title given as context. Your reply should be in format Reply: <content>

        PRTitle: ${pr.title}
        PreviousLogs: ${messages}
        CommitMessage: ${commitData.commit.message}
        CommitDiff: ${patch} }`

        core.info(`Generated prompt for commit ${commitData.sha}`);
        core.info(`Prompt: ${prompt}`);

        // use the openai api to generate a completion for the messages
        const completion = await api.createCompletion({
          model: "davinci",
          prompt: prompt,
          best_of: 1,
          max_tokens: 100,
          frequency_penalty: 0,
          presence_penalty: 0
        });

        // get the completion, replace the prefix 'Reply: ' and trim the string
        const completionText = completion.data.choices[0].text?.replace("Reply: ", "").trim();

        core.info(`Generated completion for commit ${commitData.sha}`);
        core.info(`Completion: ${completionText}`);

        // add to parsedLogs
        parsedLogs.push({
          commitHash: commitData.sha,
          changelog: completionText ?? ""
        });
      });
    }

    // add the new logs to the pr body
    newBody += `<!-- GPT-LOG:${JSON.stringify(parsedLogs)} -->`;

    // update the pr body
    const updateResult = await octokit.rest.pulls.update({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: number,
      body: newBody
    });

    core.info(`Updated PR body with new logs`);
    core.info(`Result: ${updateResult.status}`);
    core.info(`----------------------------------------`);

  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

// typescript type that has 2 properties, commithash and changelog
type CommitLog = {
  commitHash: string;
  changelog: string;
};

run()

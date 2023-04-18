import {
  intro,
  outro,
  confirm,
  isCancel,
  cancel,
  log,
  text,
  spinner,
} from "@clack/prompts";
import { Command } from "commander";
import { Octokit } from "@octokit/core";
import fs from "fs";
import * as path from "path";

const program = new Command();

function checkForEarlyExit<T extends any | symbol>(value: T) {
  if (typeof value === "symbol" && isCancel(value)) {
    cancel("Operation cancelled. That's ok. Come back later please. 👋");
    process.exit(0);
  } else {
    return value as Exclude<T, symbol>;
  }
}

async function getFullRepositoryList(
  octokit: Octokit,
  owner: string
): Promise<string[]> {
  const repos: string[] = [];
  let shouldContinue = true;
  let startCursor = "";

  while (shouldContinue) {
    const response = await octokit.graphql(
      `
      query($organization: String!, $cursor: String) {
        organization(login: $organization) {
            repositories(first: 100, after: $cursor) {
                edges {
                  cursor
                  node {
                      name
                  }
                }
                pageInfo {
                    hasNextPage
                }
            }
        }
      }
    `,
      {
        organization: owner,
        cursor: startCursor || undefined,
      }
    );

    shouldContinue = (response as any).organization.repositories.pageInfo
      .hasNextPage;
    startCursor = (response as any).organization.repositories.edges.slice(-1)[0]
      .cursor;

    repos.push(
      ...(response as any).organization.repositories.edges.map(
        (edge: { node: { name: string } }) => edge.node.name
      )
    );
  }

  return repos;
}

async function readPackageJsonDeps(
  octokit: Octokit,
  owner: string,
  repo: string
) {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: owner,
        repo: repo,
        path: "package.json",
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    const buff = Buffer.from((response as any).data.content, "base64");
    const text = buff.toString("ascii");

    const parsed = JSON.parse(text);

    return [
      ...Object.keys(parsed.dependencies || {}),
      ...Object.keys(parsed.devDependencies || {}),
    ];
  } catch {
    return [];
  }
}

const depsBuffer: Record<string, number> = {};
function pushToDepsBuffer(deps: string[], ignored: string) {
  deps.forEach((dep) => {
    if (!dep.includes(ignored)) {
      if (depsBuffer[dep]) {
        depsBuffer[dep]++;
      } else {
        depsBuffer[dep] = 1;
      }
    }
  });
}

program.command("collect").action(async () => {
  intro(
    `
  Hello there! Let's get started with collecting open-source dependencies in your organization.
  To query your GitHub organization, we'll need a GitHub token that can access this information in your organization.
  
  If you don't have one yet, you can get it at https://github.com/settings/tokens . 
  Make sure to create classic token, and select 'repo' access for the token for things to work correctly.
  
  We only use the token to read 'package.json' files across repositories, and the code is fully executed on this machine only! 
  You can remove the token right after this operation.
  `
  );

  try {
    const areWeReady = await confirm({
      message: "Do you have the GH token on hand?",
    });
    const areWeReadyParsed = checkForEarlyExit(areWeReady);
    if (!areWeReadyParsed) {
      log.info("Ok! Come back later when you have one, please. 👋");
      return;
    }

    const ghToken = await text({
      message: `Now let's bring up the token`,
      placeholder: "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      validate(value) {
        if (value.length === 0) return `Value is required!`;
      },
    });
    const parsedGhToken = checkForEarlyExit(ghToken);
    const ghOrgUrl = await text({
      message: `What's your organization GitHub url.`,
      placeholder: "https://github.com/",
      initialValue: "https://github.com/",
      validate(value) {
        if (value.length <= "https://github.com/".length)
          return `Value is required!`;
      },
    });
    const parseGhOrgUrl = checkForEarlyExit(ghOrgUrl);
    const ghOrgName = parseGhOrgUrl.split("/").slice(-1)[0];

    const ignoreString = await text({
      message: `Are there any internal company dependencies we should ignore in the list. This are usually private packages in company scope. If not, leave the string empty.`,
      placeholder: `@${ghOrgName}`,
      initialValue:`@${ghOrgName}`
    });
    const ignoreStringParsed = checkForEarlyExit(ignoreString);

    const octokit = new Octokit({
      auth: parsedGhToken,
    });
    const s = spinner();

    s.start(`Collecting list of repositories in your organization.`);
    const repos = await getFullRepositoryList(octokit, ghOrgName);
    s.stop(`Finished collecting repositories in your organization.`);

    s.start(
      `Searching through package.json files in ${repos.length} repositories.`
    );
    for await (let repo of repos) {
      const deps = await readPackageJsonDeps(octokit, ghOrgName, repo);
      pushToDepsBuffer(deps, ignoreStringParsed);
    }
    s.stop(`Finished collecting deps`);

    const sortedDepsBuffer = Object.fromEntries(
      Object.entries(depsBuffer).sort(([, a], [, b]) => b - a)
    );
    let content = "Dependency,Usage\n";
    Object.entries(sortedDepsBuffer).forEach(([dep, usage]) => {
      content += `${dep},${usage}\n`;
    });
    fs.writeFile(path.resolve(process.cwd(), "deps.csv"), content, (err) => {
      if (err) {
        log.error(err.message);
      }
    });

    outro(
      `You're all set! A 'deps.csv' file was generated in this folder. You can now explore the file and share it with the Catchup Days guys. 🤘`
    );
  } catch (error) {
    log.error(
      `Something's not right. Unless you have made a mistake and know what's up, please, report the error below to the Catchup Days guys and we'll make sure it's fixed soon. 🙏`
    );
    log.error((error as Error)?.message);
    process.exit(0);
  }
});

program.parse();

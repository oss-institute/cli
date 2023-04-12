"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prompts_1 = require("@clack/prompts");
const commander_1 = require("commander");
const core_1 = require("@octokit/core");
const fs_1 = __importDefault(require("fs"));
const path = __importStar(require("path"));
const program = new commander_1.Command();
function checkForEarlyExit(value) {
    if (typeof value === "symbol" && (0, prompts_1.isCancel)(value)) {
        (0, prompts_1.cancel)("Operation cancelled. That's ok. Come back later please. 👋");
        process.exit(0);
    }
    else {
        return value;
    }
}
async function getFullRepositoryList(octokit, owner) {
    const repos = [];
    let shouldContinue = true;
    let startCursor = "";
    while (shouldContinue) {
        const response = await octokit.graphql(`
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
    `, {
            organization: owner,
            cursor: startCursor || undefined,
        });
        shouldContinue = response.organization.repositories.pageInfo
            .hasNextPage;
        startCursor = response.organization.repositories.edges.slice(-1)[0]
            .cursor;
        repos.push(...response.organization.repositories.edges.map((edge) => edge.node.name));
    }
    return repos;
}
async function readPackageJsonDeps(octokit, owner, repo) {
    try {
        const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
            owner: owner,
            repo: repo,
            path: "package.json",
            headers: {
                "X-GitHub-Api-Version": "2022-11-28",
            },
        });
        const buff = Buffer.from(response.data.content, "base64");
        const text = buff.toString("ascii");
        const parsed = JSON.parse(text);
        return [
            ...Object.keys(parsed.dependencies || {}),
            ...Object.keys(parsed.devDependencies || {}),
        ];
    }
    catch {
        return [];
    }
}
const depsBuffer = {};
function pushToDepsBuffer(deps, ignored) {
    deps.forEach((dep) => {
        if (!dep.includes(ignored)) {
            if (depsBuffer[dep]) {
                depsBuffer[dep]++;
            }
            else {
                depsBuffer[dep] = 1;
            }
        }
    });
}
program.command("collect").action(async () => {
    (0, prompts_1.intro)(`
  Hello there! Let's get started with collecting open-source dependencies in your organization.
  To query your GitHub organization, we'll need a GitHub token that can access this information in your organization.
  
  If you don't have one yet, you can get it at https://github.com/settings/tokens. 
  Make sure to create classic token, and select 'repo' access for the token for things to work correctly.
  
  We only use the token to read 'package.json' files across repositories, and the code is fully executed on this machine only! 
  You can remove the token right after this operation.
  `);
    try {
        const areWeReady = await (0, prompts_1.confirm)({
            message: "Do you have the GH token on hand?",
        });
        const areWeReadyParsed = checkForEarlyExit(areWeReady);
        if (!areWeReadyParsed) {
            prompts_1.log.info("Ok! Come back later when you have one, please. 👋");
            return;
        }
        const ghToken = await (0, prompts_1.text)({
            message: `Now let's bring up the token`,
            placeholder: "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            validate(value) {
                if (value.length === 0)
                    return `Value is required!`;
            },
        });
        const parsedGhToken = checkForEarlyExit(ghToken);
        const ghOrgUrl = await (0, prompts_1.text)({
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
        const ignoreString = await (0, prompts_1.text)({
            message: `Are there any internal company dependencies we should ignore in the list. This are usually private packages in company scope. If not, leave the string empty.`,
            placeholder: `@${ghOrgName}`,
        });
        const ignoreStringParsed = checkForEarlyExit(ignoreString);
        const octokit = new core_1.Octokit({
            auth: parsedGhToken,
        });
        const s = (0, prompts_1.spinner)();
        s.start(`Collecting list of repositories in your organization.`);
        const repos = await getFullRepositoryList(octokit, ghOrgName);
        s.stop(`Finished collecting repositories in your organization.`);
        s.start(`Searching through package.json files in ${repos.length} repositories.`);
        for await (let repo of repos) {
            const deps = await readPackageJsonDeps(octokit, ghOrgName, repo);
            pushToDepsBuffer(deps, ignoreStringParsed);
        }
        s.stop(`Finished collecting deps`);
        const sortedDepsBuffer = Object.fromEntries(Object.entries(depsBuffer).sort(([, a], [, b]) => b - a));
        let content = "Dependency,Usage\n";
        Object.entries(sortedDepsBuffer).forEach(([dep, usage]) => {
            content += `${dep},${usage}\n`;
        });
        fs_1.default.writeFile(path.resolve(__dirname, "deps.csv"), content, (err) => {
            if (err) {
                prompts_1.log.error(err.message);
            }
        });
        (0, prompts_1.outro)(`You're all set! A 'deps.csv' file was generated in this folder. You can now explore the file and share it with the Catchup Days guys. 🤘`);
    }
    catch (error) {
        prompts_1.log.error(`Something's not right. Unless you have made a mistake and know what's up, please, report the error below to the Catchup Days guys and we'll make sure it's fixed soon. 🙏`);
        prompts_1.log.error(error?.message);
        process.exit(0);
    }
});
program.parse();

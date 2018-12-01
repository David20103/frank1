import { isArray } from "alcalzone-shared/typeguards";
import { blueBright, red } from "ansi-colors";
import { prompt } from "enquirer";
import * as fs from "fs-extra";
import * as path from "path";
import * as yargs from "yargs";
import { AnswerValue, Condition, questions } from "./lib/questions";
import { enumFilesRecursiveSync, error, executeCommand, isWindows } from "./lib/tools";

/** Where the output should be written */
const rootDir = path.resolve(yargs.argv.target || process.cwd());

function testCondition(condition: Condition | Condition[] | undefined, answers: Record<string, any>): boolean {
	if (condition == undefined) return true;

	function testSingleCondition(cond: Condition) {
		if ("value" in cond) {
			return answers[cond.name] === cond.value;
		} else if ("contains" in cond) {
			return (answers[cond.name] as AnswerValue[]).indexOf(cond.contains) > -1;
		}
		return false;
	}

	if (isArray(condition)) {
		return condition.every(cond => testSingleCondition(cond));
	} else {
		return testSingleCondition(condition);
	}

}

async function ask() {
	let answers: Record<string, any> = {};
	for (const q of questions) {
		// Headlines
		if (typeof q === "string") {
			console.log(q);
			continue;
		}
		// actual questions
		if (testCondition(q.condition, answers)) {
			// Make properties dependent on previous answers
			if (typeof q.initial === "function") {
				q.initial = q.initial(answers);
			}
			while (true) {
				// Ask the user for an answer
				const answer: Record<string, any> = await prompt(q);
				// Cancel the process if necessary
				const value = answer[q.name as string];
				if (value == undefined) {
					error("Adapter creation canceled");
					process.exit(1);
				}
				// Apply an optional transformation
				if (typeof q.resultTransform === "function") {
					const transformed = q.resultTransform(answer[q.name as string]);
					answer[q.name as string] = transformed instanceof Promise ? await transformed : transformed;
				}
				// Test the result
				if (q.action != undefined) {
					const testResult = await q.action(value);
					if (!testResult) process.exit(1);
					if (testResult === "retry") continue;
				}
				// And remember it
				answers = { ...answers, ...answer };
				break;
			}
		}
	}
	// console.dir(answers);
	return answers;
}

interface File {
	name: string;
	content: string | Buffer;
}

async function createFiles(answers: Record<string, any>): Promise<File[]> {
	const templateDir = path.join(__dirname, "./templates");
	const files = await Promise.all(
		enumFilesRecursiveSync(
			templateDir,
			(name, parentDir) => {
				const fullName = path.join(parentDir, name);
				const isDirectory = fs.statSync(fullName).isDirectory();
				return isDirectory || /\.js$/.test(name);
			},
		).map(async (f) => {
			const templateFunction = require(f);
			return {
				name: templateFunction.customPath || path.relative(templateDir, f).replace(/\.js$/i, ""),
				content: await templateFunction(answers) as string | Buffer | undefined,
			};
		}),
	);
	const necessaryFiles = files.filter(f => f.content != undefined) as File[];
	return necessaryFiles;
}

async function writeFiles(targetDir: string, files: File[]) {
	// write the files and make sure the target dirs exist
	for (const file of files) {
		await fs.outputFile(path.join(targetDir, file.name), file.content, typeof file === "string" ? "utf8" : undefined);
	}
}

async function main() {
	const answers = await ask();

	const rootDirName = path.basename(rootDir);
	// make sure we are working in a directory called ioBroker.<adapterName>
	const targetDir = rootDirName.toLowerCase() === `iobroker.${answers.adapterName.toLowerCase()}`
		? rootDir : path.join(rootDir, `ioBroker.${answers.adapterName}`)
		;

	console.log(blueBright("[1/2] creating files..."));
	const files = await createFiles(answers);
	await writeFiles(targetDir, files);

	if (!yargs.argv.noInstall || !!yargs.argv.install) {
		console.log(blueBright("[2/2] installing dependencies..."));
		await executeCommand(isWindows ? "npx.cmd" : "npx", ["npm-check-updates", "-u", "-s"], { cwd: targetDir, stdout: "ignore", stderr: "ignore" });
		await executeCommand(isWindows ? "npm.cmd" : "npm", ["install", "--quiet"], { cwd: targetDir });
		if (await fs.pathExists("npm-debug.log")) await fs.remove("npm-debug.log");
	}
	console.log(blueBright("All done! Have fun programming! ") + red("♥"));
}
main();

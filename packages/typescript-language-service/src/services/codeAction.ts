import type * as ts from 'typescript/lib/tsserverlibrary';
import * as vscode from 'vscode-languageserver-protocol';
import * as shared from '@volar/shared';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { fileTextChangesToWorkspaceEdit } from './rename';
import * as fixNames from '../utils/fixNames';
import type { Settings } from '../';

export interface FixAllData {
	type: 'fixAll',
	uri: string,
	fileName: string,
	fixIds: {}[],
}
export interface RefactorData {
	type: 'refactor',
	uri: string,
	fileName: string,
	refactorName: string,
	actionName: string,
	range: { pos: number, end: number },
}

export interface OrganizeImportsData {
	type: 'organizeImports',
	uri: string,
	fileName: string,
}

export type Data = FixAllData | RefactorData | OrganizeImportsData;

export function register(
	languageService: ts.LanguageService,
	getTextDocument: (uri: string) => TextDocument | undefined,
	settings: Settings,
) {
	return async (uri: string, range: vscode.Range, context: vscode.CodeActionContext) => {

		const document = getTextDocument(uri);
		if (!document) return;

		const [formatOptions, preferences] = await Promise.all([
			settings.getFormatOptions?.(document) ?? {},
			settings.getPreferences?.(document) ?? {},
		]);

		const fileName = shared.uriToFsPath(document.uri);
		const start = document.offsetAt(range.start);
		const end = document.offsetAt(range.end);
		let result: vscode.CodeAction[] = [];

		if (!context.only || matchOnlyKind(vscode.CodeActionKind.QuickFix)) {
			for (const error of context.diagnostics) {
				try {
					const codeFixes = languageService.getCodeFixesAtPosition(
						fileName,
						document.offsetAt(error.range.start),
						document.offsetAt(error.range.end),
						[Number(error.code)],
						formatOptions,
						preferences,
					);
					for (const codeFix of codeFixes) {
						result = result.concat(transformCodeFix(codeFix, [error], context.only ? vscode.CodeActionKind.QuickFix : vscode.CodeActionKind.Empty));
					}
				} catch { }
			}
		}

		if (context.only) {
			for (const only of context.only) {
				if (only.split('.')[0] === vscode.CodeActionKind.Refactor) {
					try {
						const refactors = languageService.getApplicableRefactors(fileName, { pos: start, end: end }, preferences, undefined, only);
						for (const refactor of refactors) {
							result = result.concat(transformRefactor(refactor));
						}
					} catch { }
				}
			}
		}
		else {
			try {
				const refactors = languageService.getApplicableRefactors(fileName, { pos: start, end: end }, preferences, undefined, undefined);
				for (const refactor of refactors) {
					result = result.concat(transformRefactor(refactor));
				}
			} catch { }
		}

		if (matchOnlyKind(vscode.CodeActionKind.SourceOrganizeImports)) {
			const action = vscode.CodeAction.create('Organize Imports', vscode.CodeActionKind.SourceOrganizeImports);
			const data: OrganizeImportsData = {
				type: 'organizeImports',
				uri,
				fileName,
			};
			// @ts-expect-error
			action.data = data;
			result.push(action);
		}

		if (matchOnlyKind(`${vscode.CodeActionKind.SourceFixAll}.ts`)) {
			const action = vscode.CodeAction.create('Fix All', vscode.CodeActionKind.SourceFixAll);
			const data: FixAllData = {
				uri,
				type: 'fixAll',
				fileName,
				fixIds: [
					fixNames.classIncorrectlyImplementsInterface,
					fixNames.awaitInSyncFunction,
					fixNames.unreachableCode,
				],
			};
			// @ts-expect-error
			action.data = data;
			result.push(action);
		}

		if (matchOnlyKind(`${vscode.CodeActionKind.Source}.removeUnused.ts`)) {
			const action = vscode.CodeAction.create('Remove all unused code', vscode.CodeActionKind.SourceFixAll);
			const data: FixAllData = {
				uri,
				type: 'fixAll',
				fileName,
				fixIds: [
					// not working and throw
					fixNames.unusedIdentifier,
					// TODO: remove patching
					'unusedIdentifier_prefix',
					'unusedIdentifier_deleteImports',
					'unusedIdentifier_delete',
					'unusedIdentifier_infer',
				],
			};
			// @ts-expect-error
			action.data = data;
			result.push(action);
		}

		if (matchOnlyKind(`${vscode.CodeActionKind.Source}.addMissingImports.ts`)) {
			const action = vscode.CodeAction.create('Add all missing imports', vscode.CodeActionKind.SourceFixAll);
			const data: FixAllData = {
				uri,
				type: 'fixAll',
				fileName,
				fixIds: [
					// not working and throw
					fixNames.fixImport,
					// TODO: remove patching
					'fixMissingImport',
				],
			};
			// @ts-expect-error
			action.data = data;
			result.push(action);
		}

		for (const codeAction of result) {
			if (codeAction.diagnostics === undefined) {
				codeAction.diagnostics = context.diagnostics;
			}
		}

		return result;

		function matchOnlyKind(kind: string) {
			if (context.only) {
				for (const only of context.only) {

					const a = only.split('.');
					const b = kind.split('.');

					if (a.length <= b.length) {

						let matchNums = 0;

						for (let i = 0; i < a.length; i++) {
							if (a[i] == b[i]) {
								matchNums++;
							}
						}

						if (matchNums === a.length)
							return true;
					}
				}
			}
		}
		function transformCodeFix(codeFix: ts.CodeFixAction, diagnostics: vscode.Diagnostic[], kind: vscode.CodeActionKind) {
			const edit = fileTextChangesToWorkspaceEdit(codeFix.changes, getTextDocument);
			const codeActions: vscode.CodeAction[] = [];
			const fix = vscode.CodeAction.create(
				codeFix.description,
				edit,
				kind,
			);
			fix.diagnostics = diagnostics;
			codeActions.push(fix);
			if (codeFix.fixAllDescription && codeFix.fixId) {
				const fixAll = vscode.CodeAction.create(
					codeFix.fixAllDescription,
					kind,
				);
				const data: FixAllData = {
					uri,
					type: 'fixAll',
					fileName,
					fixIds: [codeFix.fixId],
				};
				// @ts-expect-error
				fixAll.data = data;
				fixAll.diagnostics = diagnostics;
				codeActions.push(fixAll);
			}
			return codeActions;
		}
		function transformRefactor(refactor: ts.ApplicableRefactorInfo) {
			const codeActions: vscode.CodeAction[] = [];
			for (const action of refactor.actions) {
				const codeAction = vscode.CodeAction.create(
					action.description,
					action.kind,
				);
				const data: RefactorData = {
					uri,
					type: 'refactor',
					fileName,
					range: { pos: start, end: end },
					refactorName: refactor.name,
					actionName: action.name,
				};
				// @ts-expect-error
				codeAction.data = data;
				if (action.notApplicableReason) {
					codeAction.disabled = { reason: action.notApplicableReason };
				}
				if (refactor.inlineable) {
					codeAction.isPreferred = true;
				}
				codeActions.push(codeAction);
			}
			return codeActions
		}
	};
}
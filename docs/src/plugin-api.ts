import { join, posix } from "node:path";
import { format } from "prettier";
import ts from "typescript";
import sdkPackage from "../../packages/plugin-sdk/package.json" with { type: "json" };

export type ApiMember = { name: string; description: string };

export type ApiExport = {
  name: string;
  description: string;
  signature: string;
  members: ApiMember[];
};

export type ApiEntry = { specifier: string; exports: ApiExport[] };

export type ApiAsset = { specifier: string; path: string };

export type ApiReference = {
  apiVersion: string;
  entries: ApiEntry[];
  assets: ApiAsset[];
};

const sdk = "packages/plugin-sdk";
const repo = join(import.meta.dirname, "../..");
const github = "https://github.com/jcore9/Aphelion";
const flags = ts.TypeFormatFlags.NoTruncation;

const printer = ts.createPrinter({ removeComments: true });

function specifierOf(key: string): string {
  return key === "." ? sdkPackage.name : posix.join(sdkPackage.name, key);
}

function program(entryFiles: string[]): ts.Program {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(repo, sdk, "tsconfig.json"),
    undefined,
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (!config) throw new Error(`can't read ${sdk}/tsconfig.json`);
  return ts.createProgram(entryFiles, config.options);
}

function documentation(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | ts.Signature | undefined,
): string {
  return ts.displayPartsToString(symbol?.getDocumentationComment(checker));
}

class Collector {
  readonly checker: ts.TypeChecker;
  readonly visible = new Set<ts.Symbol>();

  constructor(readonly program: ts.Program) {
    this.checker = program.getTypeChecker();
  }

  resolve(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias
      ? this.checker.getAliasedSymbol(symbol)
      : symbol;
  }

  exportsOf(file: string): { scope: ts.SourceFile; symbols: ts.Symbol[] } {
    const scope = this.program.getSourceFile(file);
    const module = scope && this.checker.getSymbolAtLocation(scope);
    if (!module) throw new Error(`can't read the module ${file}`);
    const symbols = this.checker.getExportsOfModule(module);
    for (const symbol of symbols) this.visible.add(this.resolve(symbol));
    return { scope, symbols };
  }

  isPlatformName(symbol: ts.Symbol): boolean {
    return (symbol.declarations ?? []).every((declaration) => {
      const source = declaration.getSourceFile();
      return (
        ts.isTypeParameterDeclaration(declaration) ||
        this.program.isSourceFileDefaultLibrary(source) ||
        source.fileName.includes("/node_modules/@types/")
      );
    });
  }

  hiddenName(node: ts.Node): string | undefined {
    const name = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isTypeQueryNode(node)
        ? node.exprName
        : ts.isExpressionWithTypeArguments(node)
          ? node.expression
          : undefined;
    if (name) {
      let first: ts.Node = name;
      while (ts.isQualifiedName(first)) first = first.left;
      while (ts.isPropertyAccessExpression(first)) first = first.expression;
      const symbol = this.checker.getSymbolAtLocation(first);
      if (
        symbol &&
        !this.visible.has(this.resolve(symbol)) &&
        !this.isPlatformName(this.resolve(symbol))
      ) {
        return first.getText();
      }
    }
    return ts.forEachChild(node, (child) => this.hiddenName(child));
  }

  typeText(
    type: ts.Type | ts.Signature,
    scope: ts.SourceFile,
    extra = ts.TypeFormatFlags.None,
  ): string {
    const text =
      "getCallSignatures" in type
        ? this.checker.typeToString(type, scope, flags | extra)
        : this.checker.signatureToString(type, scope, flags | extra);
    const names = new Set([...this.visible].map(({ name }) => name));
    return text.replaceAll(
      /import\("[^"]+"\)\.(\w+)/g,
      (match, name: string) => {
        if (!names.has(name)) throw new Error(`${match} isn't exported`);
        return name;
      },
    );
  }

  zodOutput(type: ts.Type, declaration: ts.Node): ts.Type | undefined {
    const internals = type.getProperty("_zod");
    const output =
      internals &&
      this.checker
        .getTypeOfSymbolAtLocation(internals, declaration)
        .getProperty("output");
    return (
      output && this.checker.getTypeOfSymbolAtLocation(output, declaration)
    );
  }

  signature(
    name: string,
    target: ts.Symbol,
    declaration: ts.Declaration,
    scope: ts.SourceFile,
    fail: (problem: string) => Error,
  ): string {
    if (ts.isFunctionDeclaration(declaration)) {
      const type = this.checker.getTypeOfSymbol(target);
      const lines = type
        .getCallSignatures()
        .map((call) => `function ${name}${this.typeText(call, scope)};`);
      return lines.join("\n");
    }
    if (ts.isVariableDeclaration(declaration)) {
      if (!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) {
        throw fail("which isn't a const");
      }
      const type = this.checker.getTypeOfSymbol(target);
      const output = this.zodOutput(type, declaration);
      const text = output
        ? `z.ZodType<${this.typeText(output, scope)}>`
        : this.typeText(type, scope);
      return `const ${name}: ${text};`;
    }
    const hidden = this.hiddenName(declaration);
    if (ts.isTypeAliasDeclaration(declaration) && hidden) {
      const hiddenParameter = declaration.typeParameters
        ?.map((parameter) => this.hiddenName(parameter))
        .find(Boolean);
      if (hiddenParameter) {
        throw fail(
          `whose type parameters use ${hiddenParameter}, which isn't exported`,
        );
      }
      const parameters = declaration.typeParameters
        ? `<${declaration.typeParameters.map((parameter) => parameter.getText()).join(", ")}>`
        : "";
      const type = this.typeText(
        this.checker.getDeclaredTypeOfSymbol(target),
        scope,
        ts.TypeFormatFlags.InTypeAlias,
      );
      return `type ${name}${parameters} = ${type};`;
    }
    if (hidden)
      throw fail(`whose declaration uses ${hidden}, which isn't exported`);
    if (
      !ts.isInterfaceDeclaration(declaration) &&
      !ts.isTypeAliasDeclaration(declaration) &&
      !ts.isClassDeclaration(declaration)
    ) {
      throw fail(`which is a ${ts.SyntaxKind[declaration.kind]}`);
    }
    return this.sourceText(declaration);
  }

  sourceText(declaration: ts.Declaration): string {
    const withoutBodies = ts.transform(declaration, [
      (context) => {
        const visit = (node: ts.Node): ts.Node | undefined => {
          if (ts.isModifier(node) && node.kind === ts.SyntaxKind.ExportKeyword)
            return undefined;
          if (ts.isConstructorDeclaration(node)) {
            return ts.factory.updateConstructorDeclaration(
              node,
              node.modifiers,
              node.parameters,
              undefined,
            );
          }
          if (ts.isMethodDeclaration(node)) {
            return ts.factory.updateMethodDeclaration(
              node,
              node.modifiers,
              node.asteriskToken,
              node.name,
              node.questionToken,
              node.typeParameters,
              node.parameters,
              node.type,
              undefined,
            );
          }
          if (ts.isPropertyDeclaration(node)) {
            return ts.factory.updatePropertyDeclaration(
              node,
              node.modifiers,
              node.name,
              node.questionToken,
              node.type,
              undefined,
            );
          }
          return ts.visitEachChild(node, visit, context);
        };
        return (node) => ts.visitEachChild(node, visit, context);
      },
    ]).transformed[0];
    if (!withoutBodies) throw new Error("the transform returned nothing");
    return printer.printNode(
      ts.EmitHint.Unspecified,
      withoutBodies,
      declaration.getSourceFile(),
    );
  }

  members(declaration: ts.Declaration): ApiMember[] {
    const members = ts.isInterfaceDeclaration(declaration)
      ? declaration.members
      : ts.isClassDeclaration(declaration)
        ? declaration.members
        : ts.isTypeAliasDeclaration(declaration) &&
            ts.isTypeLiteralNode(declaration.type)
          ? declaration.type.members
          : [];
    return members.map((member) =>
      ts.isConstructorDeclaration(member)
        ? {
            name: "constructor",
            description: documentation(
              this.checker,
              this.checker.getSignatureFromDeclaration(member),
            ),
          }
        : {
            name: member.name?.getText() ?? "",
            description: documentation(
              this.checker,
              member.name && this.checker.getSymbolAtLocation(member.name),
            ),
          },
    );
  }

  describe(
    symbol: ts.Symbol,
    specifier: string,
    scope: ts.SourceFile,
  ): ApiExport {
    const fail = (problem: string) =>
      new Error(`${specifier} exports ${symbol.name}, ${problem}`);
    const target = this.resolve(symbol);
    const declarations = target.declarations ?? [];
    const [declaration] = declarations;
    if (!declaration) throw fail("which has no declaration");
    if (symbol.name === "default") throw fail("which is a default export");
    if (target.name !== symbol.name) throw fail(`which renames ${target.name}`);
    if (
      declarations.length > 1 &&
      !declarations.every((item) => ts.isFunctionDeclaration(item))
    ) {
      throw fail("which has more than one declaration");
    }
    return {
      name: symbol.name,
      description: documentation(this.checker, target),
      signature: this.signature(symbol.name, target, declaration, scope, fail),
      members: this.members(declaration),
    };
  }
}

function apiVersionOf(
  collector: Collector,
  entries: Map<string, { symbols: ts.Symbol[] }>,
): string {
  const symbol = entries
    .get(sdkPackage.name)
    ?.symbols.find(({ name }) => name === "pluginApiVersion");
  const type =
    symbol && collector.checker.getTypeOfSymbol(collector.resolve(symbol));
  if (!type?.isStringLiteral()) {
    throw new Error(
      `${sdkPackage.name} must export pluginApiVersion as a string literal`,
    );
  }
  return type.value;
}

export function collectPluginApi(): ApiReference {
  const modules = new Map<string, string>();
  const assets: ApiAsset[] = [];
  for (const [key, target] of Object.entries(sdkPackage.exports)) {
    const specifier = specifierOf(key);
    if (target.endsWith(".ts")) {
      modules.set(specifier, join(repo, sdk, target));
    } else if (target.endsWith(".json")) {
      assets.push({ specifier, path: posix.join(sdk, target) });
    } else {
      throw new Error(
        `${specifier} points at ${target}, which isn't .ts or .json`,
      );
    }
  }
  const collector = new Collector(program([...modules.values()]));
  const symbols = new Map(
    [...modules].map(([specifier, file]) => [
      specifier,
      collector.exportsOf(file),
    ]),
  );
  const entries = [...symbols].map(([specifier, { scope, symbols }]) => ({
    specifier,
    exports: symbols
      .map((symbol) => collector.describe(symbol, specifier, scope))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  }));
  return { apiVersion: apiVersionOf(collector, symbols), entries, assets };
}

const sitePages = `${github}/blob/dev/docs/reference/`;

function renderExport(item: ApiExport): string {
  const text = (description: string) => description.replaceAll(sitePages, "");
  const members = item.members.map(
    ({ name, description }) => `- \`${name}\`: ${text(description)}`,
  );
  return [
    `### \`${item.name}\``,
    text(item.description),
    `\`\`\`ts\n${item.signature}\n\`\`\``,
    ...(members.length > 0 ? [members.join("\n")] : []),
  ].join("\n\n");
}

export async function renderPluginApi(
  reference: ApiReference,
): Promise<string> {
  const usesZod = reference.entries.some(({ exports }) =>
    exports.some(({ signature }) => signature.includes("z.ZodType<")),
  );
  const sections = [
    "# Plugin API reference",
    "<!-- Generated by docs/src/plugin-api.test.ts. Don't edit this file. Regenerate: bun --bun vitest run docs/src/plugin-api.test.ts -u -->",
    `This page lists what a plugin can import from \`${sdkPackage.name}\`, for plugin API version ${reference.apiVersion}. A plugin's manifest names the plugin API versions it works with ([the API range](plugin-manifest.md#the-api-range)). A test generates this page from the types and doc comments in [\`${sdk}/src\`](${github}/tree/dev/${sdk}/src) and fails when this page is out of date.`,
    ...(usesZod
      ? [
          "A `z.ZodType<T>` on this page is a [Zod](https://zod.dev/) schema. Its `parse` method checks a value and returns it as a `T`, or throws when the value doesn't match.",
        ]
      : []),
    ...reference.entries.flatMap(({ specifier, exports }) => [
      `## \`${specifier}\``,
      ...exports.map(renderExport),
    ]),
    ...(reference.assets.length > 0
      ? [
          "## Files",
          "The package also exports these files.",
          reference.assets
            .map(
              ({ specifier, path }) =>
                `- [\`${specifier}\`](${github}/blob/dev/${path})`,
            )
            .join("\n"),
        ]
      : []),
  ];
  return format(sections.join("\n\n"), { parser: "markdown" });
}

import { Project, Node, SyntaxKind, ts, SourceFile } from 'ts-morph';

const getTsConfig = () => {
  const tsConfigFilePath = ts.findConfigFile(process.cwd(), ts.sys.fileExists);
  if (tsConfigFilePath) {
    const configFile = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile);
    return ts.parseJsonConfigFileContent(configFile.config, ts.sys, '');
  }
};

export const trimQuotes = (str: string) => {
  return str.slice(1, -1);
};

export const getFileName = (str: string) => {
  const index = str.lastIndexOf('.');
  return str.slice(0, index);
};

type Config = {
  projectFiles: string;
};

type FilesImports = Record<string, Record<string, number>>;

const getImportMap = (sourceFiles: SourceFile[]) => {
  const filesImports: FilesImports = {};
  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    const tsConfig = getTsConfig();

    if (tsConfig) {
      const imports = sourceFile.getImportStringLiterals();
      imports.forEach((literal) => {
        const importPosition = literal.getPos();
        const literalText = trimQuotes(literal.getText());
        const resolvedModule = ts.resolveModuleName(literalText, filePath, tsConfig.options, ts.sys);
        const resolvedFileName = resolvedModule.resolvedModule?.resolvedFileName;
        if (resolvedFileName) {
          if (filesImports[resolvedFileName]) {
            filesImports[resolvedFileName] = {
              ...filesImports[resolvedFileName],
              [filePath]: importPosition,
            };
          } else {
            filesImports[resolvedFileName] = { [filePath]: importPosition };
          }
        }
      });
    }
  }
  return filesImports;
};

type ExportMap = Record<string, string[]>;

const migrateAndGetExportMap = (sourceFiles: SourceFile[]) => {
  const exportMap: ExportMap = {};
  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    const exportInFile: string[] = [];

    sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach((node) => {
      if (node.getFullText().trim() === 'module.exports') {
        const parent = node.getParent();

        // module.exports.sum = sum;
        if (Node.isPropertyAccessExpression(parent)) {
          const parentOfProp = parent.getParent();
          if (Node.isBinaryExpression(parentOfProp)) {
            const exportedName = parentOfProp.getRight().getFullText().trim();
            exportInFile.push(exportedName);
            const parentOfBinaryExpr = parentOfProp.getParent();
            if (Node.isExpressionStatement(parentOfBinaryExpr)) {
              return parentOfBinaryExpr.remove();
            }
          }
        }

        // module.exports = {
        if (Node.isBinaryExpression(parent)) {
          const parentOfBinaryExpr = parent.getParent();
          if (Node.isExpressionStatement(parentOfBinaryExpr)) {
            const extText = parent.getRight().getFullText();
            const fileName = getFileName(sourceFile.getBaseName());
            sourceFile.insertStatements(0, `export const ${fileName} = ${extText}`);
            exportInFile.push(fileName);
            parentOfBinaryExpr.remove();
          }
        }
      }
    });

    if (exportInFile.length) {
      exportMap[filePath] = exportInFile;
    }

    sourceFile.forEachDescendant((node) => {
      if (Node.isVariableStatement(node)) {
        exportInFile.forEach((exportName) => {
          for (const declarations of node.getDeclarations()) {
            const varName = declarations.getName();
            if (exportName === varName) {
              node.setIsExported(true);
            }
          }
        });
      }
    });
  }
  return exportMap;
};

const checkAndFixImport = ({
  project,
  fileImports,
  exportMap,
}: {
  project: Project;
  fileImports: FilesImports;
  exportMap: ExportMap;
}) => {
  for (const fileImportKey in fileImports) {
    for (const fileImportKeyElement in fileImports[fileImportKey]) {
      const personFile = project.getSourceFile(fileImportKeyElement);
      if (personFile) {
        const node = personFile.getDescendantAtPos(fileImports[fileImportKey][fileImportKeyElement]);
        if (node) {
          const parent = node.getParent();
          if (Node.isImportDeclaration(parent)) {
            const importClause = parent.getImportClause();
            if (importClause) {
              const namedBindings = importClause.getNamedBindings();

              // import { sum } from './sum';
              if (Node.isNamedImports(namedBindings)) {
                const namedImports = importClause.getNamedImports();
                const namedImportsText = namedImports.map((namedImport) => namedImport.getText());
                const isImportsIncluded = namedImportsText.every((importText) =>
                  exportMap[fileImportKey].includes(importText),
                );
                if (isImportsIncluded) {
                  console.log('all imports included');
                }
              }

              // import * as actions from './subscriptions';
              if (Node.isNamespaceImport(namedBindings)) {
                const aliasName = namedBindings.getName();
                if (exportMap[fileImportKey].length === 1) {
                  namedBindings.replaceWithText(`{${exportMap[fileImportKey][0]} as ${aliasName}}`);
                }
              }
            }
          }
        }
      }
    }
  }
};

export const migrate = (config: Config) => {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });
  const sourceFiles = project.getSourceFiles(config.projectFiles);

  const fileImports = getImportMap(sourceFiles);
  console.log('fileImports');
  console.log(fileImports);
  const exportMap = migrateAndGetExportMap(sourceFiles);
  console.log('exportMap');
  console.log(exportMap);

  checkAndFixImport({
    project,
    fileImports,
    exportMap,
  });

  return project.save();
};

// migrate({
//   projectFiles: 'test/test-project/case2/*.{tsx,ts,js}',
// });

import { Project, Node, SyntaxKind, ts, SourceFile, CompilerOptions } from 'ts-morph';
import cliProgress from 'cli-progress';
import { camelCase } from 'string-ts';
import path from 'path';

const getTsConfig = () => {
  const tsConfigFilePath = ts.findConfigFile(process.cwd(), ts.sys.fileExists);
  if (tsConfigFilePath) {
    const configFile = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile);
    return ts.parseJsonConfigFileContent(configFile.config, ts.sys, '');
  }
};

const getResolvedFileName = (
  moduleName: string,
  containingFile: string,
  tsOptions: CompilerOptions
) => {
  const resolvedModuleName = ts.resolveModuleName(moduleName, containingFile, tsOptions, ts.sys);
  if (resolvedModuleName.resolvedModule?.resolvedFileName) {
    if (resolvedModuleName.resolvedModule.resolvedFileName.includes(process.cwd())) {
      return resolvedModuleName.resolvedModule?.resolvedFileName;
    } else {
      // handle alias
      return path.join(process.cwd(), resolvedModuleName.resolvedModule.resolvedFileName);
    }
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

type FileUsageMap = Record<string, Record<string, number>>;

const getFileUsageMap = (sourceFiles: SourceFile[]) => {
  const filesImports: FileUsageMap = {};
  const tsConfig = getTsConfig();

  const bar0 = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar0.start(sourceFiles.length - 1, 0);

  if (tsConfig) {
    sourceFiles.forEach((sourceFile, index) => {
      const filePath = sourceFile.getFilePath();

      const imports = sourceFile.getImportStringLiterals();
      imports.forEach((literal) => {
        const importPosition = literal.getPos();
        const literalText = trimQuotes(literal.getText());
        const resolvedFileName = getResolvedFileName(literalText, filePath, tsConfig.options);
        if (resolvedFileName && !resolvedFileName.includes('node_modules')) {
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
      bar0.update(index);
    });
    bar0.stop();
  }

  return filesImports;
};

type FileExportNamesMap = Record<string, string[]>;

const migrateAndGetFileExportNamesMap = (sourceFiles: SourceFile[]) => {
  const exportMap: FileExportNamesMap = {};
  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    const exportInFile: string[] = [];

    if (
      [
        'sagas/index.ts',
        'bundled-subscription/index.ts',
        'reducers/orders/index.js',
        'reducers/otp/index.js',
        'reducers/payfac-profile/index.js',
        'reducers/promotions/index.js',
        'reducers/prospero/index.js',
        'reducers/rad/index.js',
        'reducers/receipts/index.js',
        'reducers/reporting/index.js',
        'reducers/settlement/index.js',
        'reducers/store/index.js',
        'reducers/stores-with-domain-attributes/index.js',
        'reducers/terminals/index.js',
        'reducers/transactions-aggregate/index.js',
        'reducers/twilio/index.js',
        'reducers/upload/index.js',
        'reducers/website/index.js',
        'reducers/website-account/index.js',
        'src/sagas/config/index.js',
      ].some((path) => filePath.includes(path))
    ) {
      continue;
    }

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


        if (Node.isBinaryExpression(parent)) {
          const parentOfBinaryExpr = parent.getParent();
          if (Node.isExpressionStatement(parentOfBinaryExpr)) {
            const rightSide = parent.getRight();

            // module.exports = {
            if (Node.isObjectLiteralExpression(rightSide)) {
              const properties=  rightSide.getProperties()
              const isAllShorthand = properties.every(property => Node.isShorthandPropertyAssignment(property))
              if (isAllShorthand) {
                for (const property of properties) {
                  if (Node.isShorthandPropertyAssignment(property)) {
                    exportInFile.push(property.getText());
                    const referencedSymbols= property.findReferences()

                    for (const referencedSymbol of referencedSymbols) {
                      for (const reference of referencedSymbol.getReferences()) {
                        const parent = reference.getNode().getParentOrThrow().getParentOrThrow().getParentOrThrow();
                        if (Node.isVariableStatement(parent)) {
                          parent.setIsExported(true)

                        }
                      }
                    }
                  }
                }
                return parentOfBinaryExpr.remove();
              } else {
                const extText = rightSide.getFullText().trim();
                const fileName = getFileName(sourceFile.getBaseName());
                const camelCasedName = camelCase(fileName);
                sourceFile.insertStatements(0, `export const ${camelCasedName} = ${extText}`);
                exportInFile.push(camelCasedName);
                return parentOfBinaryExpr.remove();
              }
            }

            // module.exports = sum;
            if (Node.isIdentifier(rightSide)) {
              exportInFile.push(rightSide.getText());
              const referencedSymbols= rightSide.findReferences()

              for (const referencedSymbol of referencedSymbols) {
                for (const reference of referencedSymbol.getReferences()) {
                  const parent = reference.getNode().getParentOrThrow().getParentOrThrow().getParentOrThrow();
                  if (Node.isVariableStatement(parent)) {
                    parent.setIsExported(true)
                    return parentOfBinaryExpr.remove();
                  }
                }
              }
            }
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
  fileUsageMap,
  fileExportNamesMap,
}: {
  project: Project;
  fileUsageMap: FileUsageMap;
  fileExportNamesMap: FileExportNamesMap;
}) => {
  for (const fileUsageMapKey in fileUsageMap) {
    if (fileExportNamesMap[fileUsageMapKey]) {
      for (const fileImportKeyElement in fileUsageMap[fileUsageMapKey]) {
        const personFile = project.getSourceFile(fileImportKeyElement);
        console.log('fileImportKeyElement');
        console.log(fileImportKeyElement);
        const statement = fileImportKeyElement ===  '/Users/aoriekhov/git/work/poynt/mercury/src/store/sagas/business/index.ts' && fileUsageMapKey === '/Users/aoriekhov/git/work/poynt/mercury/src/schemas/business/index.js';

        if (statement) {
          console.log('schemas/business personFile', personFile);
        }
        if (personFile) {
          const node = personFile.getDescendantAtPos(fileUsageMap[fileUsageMapKey][fileImportKeyElement]);
          if (node) {
            const parent = node.getParent();
            if (statement) {
              console.log('schemas/business node');
            }
            if (Node.isImportDeclaration(parent)) {
              const importClause = parent.getImportClause();
              if (statement) {
                console.log('schemas/business isImportDeclaration');
              }
              if (importClause) {
                const namedBindings = importClause.getNamedBindings();
                if (statement) {
                  console.log('schemas/business dddddddddddd');
                  console.log(namedBindings?.getKindName());
                  console.log(namedBindings?.getFullText());
                }

                // import { sum } from './sum';
                if (Node.isNamedImports(namedBindings)) {
                  const namedImports = importClause.getNamedImports();
                  const namedImportsText = namedImports.map((namedImport) => namedImport.getText());
                  const isImportsIncluded = namedImportsText.every((importText) =>
                    fileExportNamesMap[fileUsageMapKey].includes(importText),
                  );
                  if (isImportsIncluded) {
                    console.log('all imports included');
                  }
                }

                // import * as actions from './subscriptions';
                if (Node.isNamespaceImport(namedBindings)) {
                  const aliasName = namedBindings.getName();
                  if (fileExportNamesMap[fileUsageMapKey] && fileExportNamesMap[fileUsageMapKey].length === 1) {
                    namedBindings.replaceWithText(`{ ${fileExportNamesMap[fileUsageMapKey][0]} as ${aliasName} }`);
                  }
                }

                // import subtract from './subtract';
                if (namedBindings === undefined) {
                  console.log('fileUsageMapKey');
                  console.log(fileUsageMapKey);
                  console.log('fileExportNamesMap[fileUsageMapKey]');
                  console.log(fileExportNamesMap[fileUsageMapKey]);
                  if (fileExportNamesMap[fileUsageMapKey] && fileExportNamesMap[fileUsageMapKey].length === 1) {
                    importClause.replaceWithText(`{ ${fileExportNamesMap[fileUsageMapKey][0]} }`);
                  }
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
  // project.emitSync();
  const sourceFiles = project.getSourceFiles(config.projectFiles);
  console.log(sourceFiles.map(file => file.getFilePath()));

  const fileUsageMap = getFileUsageMap(sourceFiles);
  console.log('fileUsageMap');
  console.log(fileUsageMap);
  const fileExportNamesMap = migrateAndGetFileExportNamesMap(sourceFiles);
  console.log('fileExportNamesMap');
  console.log(fileExportNamesMap);

  checkAndFixImport({
    project,
    fileUsageMap,
    fileExportNamesMap,
  });

  return project.save();
};

// migrate({
//   projectFiles: 'src/**/*.{tsx,ts,js}',
// });

// migrate({
//   projectFiles: 'test/test-project/case4shorthand/*.{tsx,ts,js}',
// });

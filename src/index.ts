import { Project, Node, SyntaxKind, ts, SourceFile } from 'ts-morph';
import cliProgress from 'cli-progress';
import { camelCase } from 'string-ts';

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

type fileUsageMap = Record<string, Record<string, number>>;

const getFileUsageMap = (sourceFiles: SourceFile[]) => {
  const filesImports: fileUsageMap = {};
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
        const resolvedModule = ts.resolveModuleName(literalText, filePath, tsConfig.options, ts.sys);
        const resolvedFileName = resolvedModule.resolvedModule?.resolvedFileName;
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

type fileExportNamesMap = Record<string, string[]>;

const migrateAndGetFileExportNamesMap = (sourceFiles: SourceFile[]) => {
  const exportMap: fileExportNamesMap = {};
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
        console.log(node.getFullText());
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
            const extText = parent.getRight().getFullText().trim();
            const fileName = getFileName(sourceFile.getBaseName());
            const camelCasedName = camelCase(fileName);
            sourceFile.insertStatements(0, `export const ${camelCasedName} = ${extText}`);
            exportInFile.push(camelCasedName);
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
  fileUsageMap,
  fileExportNamesMap,
}: {
  project: Project;
  fileUsageMap: fileUsageMap;
  fileExportNamesMap: fileExportNamesMap;
}) => {
  for (const fileImportKey in fileUsageMap) {
    if (fileExportNamesMap[fileImportKey]) {
      for (const fileImportKeyElement in fileUsageMap[fileImportKey]) {
        const personFile = project.getSourceFile(fileImportKeyElement);
        if (personFile) {
          const node = personFile.getDescendantAtPos(fileUsageMap[fileImportKey][fileImportKeyElement]);
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
                    fileExportNamesMap[fileImportKey].includes(importText),
                  );
                  if (isImportsIncluded) {
                    console.log('all imports included');
                  }
                }

                // import * as actions from './subscriptions';
                if (Node.isNamespaceImport(namedBindings)) {
                  const aliasName = namedBindings.getName();
                  console.log('fileImportKey');
                  console.log(fileImportKey);
                  if (fileExportNamesMap[fileImportKey] && fileExportNamesMap[fileImportKey].length === 1) {
                    namedBindings.replaceWithText(`{ ${fileExportNamesMap[fileImportKey][0]} as ${aliasName} }`);
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
//   projectFiles: 'test/test-project/case2/**/*.{tsx,ts,js}',
// });

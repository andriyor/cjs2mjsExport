import path from 'path';

import { CompilerOptions, ts } from 'ts-morph';

export const getTsConfig = () => {
  const tsConfigFilePath = ts.findConfigFile(process.cwd(), ts.sys.fileExists);
  if (tsConfigFilePath) {
    const configFile = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile);
    return ts.parseJsonConfigFileContent(configFile.config, ts.sys, '');
  }
};

export const getResolvedFileName = (moduleName: string, containingFile: string, tsOptions: CompilerOptions) => {
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

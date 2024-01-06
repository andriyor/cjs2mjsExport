import util from 'node:util';
import fs from 'node:fs';

import { beforeAll, describe, it, expect, afterAll } from 'vitest';

import { migrate } from '../src';
import { prepareTestCases } from './helper';

const exec = util.promisify(require('node:child_process').exec);

beforeAll(async () => {
  await migrate({
    projectFiles: 'test/test-project/**/*.{tsx,ts}',
  });
});

afterAll(async () => {
  await exec('git stash push -- test/test-project');
});

describe('cjs2mjsExport', () => {
  const testCases = prepareTestCases();
  it.each(testCases)('module %s should be the same as %s module', (actual, expected) => {
    const methodFile = fs.readFileSync(actual, 'utf-8');
    const expectedMethodFile = fs.readFileSync(expected, 'utf-8');
    expect(methodFile).toEqual(expectedMethodFile);
  });
});

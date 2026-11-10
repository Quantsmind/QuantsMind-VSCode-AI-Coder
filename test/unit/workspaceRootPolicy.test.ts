import { expect } from 'chai';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROOT_MARKERS,
  defaultRootMarkerProbe,
  scoreWorkspaceRoot,
  selectWorkspaceRoot,
  type RootMarkerProbe,
  type WorkspaceRootCandidate,
} from '../../src/workspace/rootPolicy';
import { WorkspaceTools } from '../../src/agent/workspaceTools';
import { ProjectIntelligenceService } from '../../src/project/intelligence';
import { AgentOrchestrator } from '../../src/agent/orchestrator';

/** Virtual candidate: the fsPath is never touched because every scoring test injects a probe. */
function candidate(name: string, index: number): WorkspaceRootCandidate {
  const fsPath = `/virtual/${name}`;
  return {
    name,
    index,
    uri: {
      fsPath,
      toString: () => `file://${fsPath}`,
    },
  };
}

function markerPaths(fsPath: string, markers: readonly string[]): string[] {
  return markers.map((marker) => `${fsPath}/${marker}`);
}

/** Fake marker presence: only the listed `<fsPath>/<marker>` pairs exist. */
function probePresent(present: readonly string[]): RootMarkerProbe {
  const paths = new Set(present);
  return (fsPath, marker) => paths.has(`${fsPath}/${marker}`);
}

const ALL_MARKERS = ROOT_MARKERS.map((entry) => entry.marker);

const PROJECT_MARKERS = ['package.json', 'src', '.git'];
const PROJECT_SCORE = 10; // package.json 5 + src 3 + .git 2

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, '..', '..', '..', 'src', relativePath), 'utf8');
}

suite('workspace root selection policy (D4)', () => {
  test('returns undefined when no workspace folder is open', () => {
    const probe = probePresent([]);
    expect(selectWorkspaceRoot<WorkspaceRootCandidate>(undefined, probe)).to.equal(undefined);
    expect(selectWorkspaceRoot<WorkspaceRootCandidate>([], probe)).to.equal(undefined);
  });

  test('returns the single open folder itself, even without any project marker', () => {
    const only = candidate('lonely', 0);
    expect(selectWorkspaceRoot([only], probePresent([]))).to.equal(only);
  });

  test('multi-root: keeps the FIRST folder when the first folder scores higher', () => {
    const first = candidate('project', 0);
    const second = candidate('notes', 1);
    const probe = probePresent([
      ...markerPaths(first.uri.fsPath, PROJECT_MARKERS),
      ...markerPaths(second.uri.fsPath, ['README.md']),
    ]);

    expect(scoreWorkspaceRoot(first, probe)).to.equal(PROJECT_SCORE);
    expect(scoreWorkspaceRoot(second, probe)).to.equal(1);
    expect(selectWorkspaceRoot([first, second], probe)).to.equal(first);
  });

  test('multi-root regression: a higher-scoring SECOND folder wins over the first folder', () => {
    // The original defect selected workspaceFolders[0], so a notes/scratch folder
    // opened first shadowed the real project opened second.
    const first = candidate('notes', 0);
    const second = candidate('project', 1);
    const probe = probePresent([
      ...markerPaths(first.uri.fsPath, ['README.md', 'docs']),
      ...markerPaths(second.uri.fsPath, PROJECT_MARKERS),
    ]);

    expect(scoreWorkspaceRoot(first, probe)).to.equal(3);
    expect(scoreWorkspaceRoot(second, probe)).to.equal(PROJECT_SCORE);
    const selected = selectWorkspaceRoot([first, second], probe);
    expect(selected).to.equal(second);
    expect(selected?.index).to.equal(1);
  });

  test('multi-root: a tie on score is won by the lowest workspace index', () => {
    const notes = candidate('notes', 0);
    const project = candidate('project', 1);
    const mirror = candidate('mirror', 2);
    const probe = probePresent([
      ...markerPaths(notes.uri.fsPath, ['README.md']),
      ...markerPaths(project.uri.fsPath, PROJECT_MARKERS),
      ...markerPaths(mirror.uri.fsPath, PROJECT_MARKERS),
    ]);

    expect(scoreWorkspaceRoot(project, probe)).to.equal(scoreWorkspaceRoot(mirror, probe));
    expect(selectWorkspaceRoot([notes, project, mirror], probe)).to.equal(project);
  });

  test('multi-root: the tie winner is independent of the input array order', () => {
    const notes = candidate('notes', 0);
    const project = candidate('project', 1);
    const mirror = candidate('mirror', 2);
    const probe = probePresent([
      ...markerPaths(notes.uri.fsPath, ['README.md']),
      ...markerPaths(project.uri.fsPath, PROJECT_MARKERS),
      ...markerPaths(mirror.uri.fsPath, PROJECT_MARKERS),
    ]);

    const orders: readonly (readonly WorkspaceRootCandidate[])[] = [
      [notes, project, mirror],
      [mirror, project, notes],
      [project, mirror, notes],
      [mirror, notes, project],
    ];
    for (const folders of orders) {
      expect(selectWorkspaceRoot(folders, probe), folders.map((f) => f.name).join(',')).to.equal(
        project,
      );
    }
  });

  test('multi-root: the highest-scoring winner is independent of the input array order', () => {
    const notes = candidate('notes', 0);
    const docs = candidate('docs-only', 1);
    const project = candidate('project', 2);
    const probe = probePresent([
      ...markerPaths(notes.uri.fsPath, ['README.md']),
      ...markerPaths(docs.uri.fsPath, ['docs']),
      ...markerPaths(project.uri.fsPath, PROJECT_MARKERS),
    ]);

    const orders: readonly (readonly WorkspaceRootCandidate[])[] = [
      [notes, docs, project],
      [project, docs, notes],
      [docs, project, notes],
      [project, notes, docs],
    ];
    for (const folders of orders) {
      expect(selectWorkspaceRoot(folders, probe), folders.map((f) => f.name).join(',')).to.equal(
        project,
      );
    }
  });

  test('returns the original candidate object, not a copy', () => {
    interface TaggedFolder extends WorkspaceRootCandidate {
      readonly tag: string;
    }
    const notes: TaggedFolder = { ...candidate('notes', 0), tag: 'decoy' };
    const project: TaggedFolder = { ...candidate('project', 1), tag: 'original-instance' };
    const probe = probePresent(markerPaths(project.uri.fsPath, PROJECT_MARKERS));
    const folders: readonly TaggedFolder[] = [notes, project];

    const selected = selectWorkspaceRoot(folders, probe);

    expect(selected).to.equal(project);
    expect(selected?.tag).to.equal('original-instance');
    expect(selectWorkspaceRoot([project], probe)).to.equal(project);
  });

  test('skips marker probing when the root is already determined', () => {
    const guarded: RootMarkerProbe = () => {
      throw new Error('marker probe must not run when there is nothing to compare');
    };
    const only = candidate('lonely', 0);

    expect(selectWorkspaceRoot<WorkspaceRootCandidate>(undefined, guarded)).to.equal(undefined);
    expect(selectWorkspaceRoot<WorkspaceRootCandidate>([], guarded)).to.equal(undefined);
    expect(selectWorkspaceRoot([only], guarded)).to.equal(only);
  });
});

suite('workspace root marker scoring (D4)', () => {
  test('pins the documented marker weights', () => {
    const weights: Record<string, number> = {};
    for (const { marker, weight } of ROOT_MARKERS) {
      weights[marker] = weight;
    }
    expect(weights).to.deep.equal({
      'package.json': 5,
      src: 3,
      docs: 2,
      '.git': 2,
      'README.md': 1,
    });
  });

  test('sums only the markers the probe reports present', () => {
    const folder = candidate('project', 0);
    const base = folder.uri.fsPath;

    expect(scoreWorkspaceRoot(folder, probePresent(markerPaths(base, ['package.json'])))).to.equal(5);
    expect(
      scoreWorkspaceRoot(folder, probePresent(markerPaths(base, ['package.json', 'src']))),
    ).to.equal(8);
    expect(scoreWorkspaceRoot(folder, probePresent(markerPaths(base, PROJECT_MARKERS)))).to.equal(
      PROJECT_SCORE,
    );
    expect(scoreWorkspaceRoot(folder, probePresent(markerPaths(base, ALL_MARKERS)))).to.equal(13);
  });

  test('scores a folder with no markers as zero', () => {
    const folder = candidate('empty', 0);
    expect(scoreWorkspaceRoot(folder, probePresent([]))).to.equal(0);
    expect(scoreWorkspaceRoot(folder, () => false)).to.equal(0);
  });

  test('ignores markers that are not part of the policy', () => {
    const folder = candidate('project', 0);
    const base = folder.uri.fsPath;
    const unknown = ['node_modules', 'tsconfig.json', '.vscode', 'Cargo.toml'];

    expect(scoreWorkspaceRoot(folder, probePresent(markerPaths(base, unknown)))).to.equal(0);
    expect(
      scoreWorkspaceRoot(folder, probePresent(markerPaths(base, [...unknown, 'package.json']))),
    ).to.equal(5);
    // A probe that claims everything exists still cannot exceed the policy total.
    expect(scoreWorkspaceRoot(folder, () => true)).to.equal(13);
  });

  test('probes the policy markers under each candidate fsPath', () => {
    const first = candidate('notes', 0);
    const second = candidate('project', 1);
    const calls: string[] = [];
    const probe: RootMarkerProbe = (fsPath, marker) => {
      calls.push(`${fsPath}/${marker}`);
      return false;
    };

    selectWorkspaceRoot([first, second], probe);

    expect(calls).to.have.members([
      ...markerPaths(first.uri.fsPath, ALL_MARKERS),
      ...markerPaths(second.uri.fsPath, ALL_MARKERS),
    ]);
  });
});

suite('default root marker probe (D4)', () => {
  test('returns false for every marker under an absent temp directory without throwing', () => {
    const absent = join(tmpdir(), `quantsmind-root-policy-absent-${process.pid}-${Date.now()}`);
    expect(existsSync(absent), 'the probe path must not exist').to.equal(false);

    for (const marker of ALL_MARKERS) {
      expect(() => defaultRootMarkerProbe(absent, marker)).to.not.throw();
      expect(defaultRootMarkerProbe(absent, marker), marker).to.equal(false);
    }
    expect(existsSync(absent), 'the probe must not create anything').to.equal(false);
  });

  test('returns false instead of throwing for an unusable path', () => {
    const unusable = join(tmpdir(), 'quantsmind-root-policy\u0000invalid');
    expect(() => defaultRootMarkerProbe(unusable, 'package.json')).to.not.throw();
    expect(defaultRootMarkerProbe(unusable, 'package.json')).to.equal(false);
  });
});

// Source contract, not behaviour: these four call sites import `vscode`, so they can only
// execute inside an extension host; here we pin that they all delegate to the one policy.
suite('workspace root consumer source contract (D4)', () => {
  test('indexService.getRoot delegates to selectWorkspaceRoot', () => {
    const source = readSource(join('workspace', 'indexService.ts'));
    expect(source).to.match(
      /private getRoot\(\)[^{]*\{\s*return selectWorkspaceRoot\(vscode\.workspace\.workspaceFolders\);/,
    );
  });

  test('chatViewProvider.workspaceRoot delegates to selectWorkspaceRoot', () => {
    const source = readSource(join('chat', 'chatViewProvider.ts'));
    expect(source).to.match(
      /private workspaceRoot\(\)[^{]*\{\s*return selectWorkspaceRoot\(vscode\.workspace\.workspaceFolders\);/,
    );
  });

  test('changeService.createApplyFs delegates to selectWorkspaceRoot', () => {
    const source = readSource(join('changes', 'changeService.ts'));
    const start = source.indexOf('createApplyFs(');
    expect(start, 'createApplyFs must exist').to.be.at.least(0);
    const body = source.slice(start, start + 600);
    expect(body).to.contain('const root = selectWorkspaceRoot(vscode.workspace.workspaceFolders);');
  });

  test('agent runtime workspaceRoot delegates to selectWorkspaceRoot', () => {
    const source = readSource(join('agent', 'runtime.ts'));
    expect(source).to.match(
      /function workspaceRoot\(\)[^{]*\{\s*return selectWorkspaceRoot\(vscode\.workspace\.workspaceFolders\);/,
    );
  });

  test('changeService no longer applies edits to the first workspace folder', () => {
    const source = readSource(join('changes', 'changeService.ts'));
    // This is the exact "index one root, edit another" expression from the audit.
    expect(source).to.not.match(/workspaceFolders\s*(?:\?\.)?\[\s*0\s*\]/);
  });

  test('all four consumers import the shared root policy module', () => {
    const files = [
      join('workspace', 'indexService.ts'),
      join('chat', 'chatViewProvider.ts'),
      join('changes', 'changeService.ts'),
      join('agent', 'runtime.ts'),
    ];
    for (const file of files) {
      const source = readSource(file);
      expect(source, file).to.match(/import \{ selectWorkspaceRoot \} from '[^']*rootPolicy'/);
      expect(source, file).to.contain('selectWorkspaceRoot(');
    }
  });

  test('attachment discovery is scoped to the selected root, not every workspace folder', () => {
    const source = readSource(join('context', 'contextService.ts'));
    expect(source).to.match(/import \{ selectWorkspaceRoot \} from '[^']*rootPolicy'/);
    const start = source.indexOf('async listAttachableFiles(');
    expect(start).to.be.at.least(0);
    const body = source.slice(start, source.indexOf('\n  }', start));
    expect(body).to.contain('selectWorkspaceRoot(vscode.workspace.workspaceFolders)');
    expect(body).to.contain("new vscode.RelativePattern(root, '**/*')");
    expect(body).to.not.contain("findFiles('**/*'");
  });
});

suite('live workspace root labels (D4)', () => {
  test('workspace context reports the root selected at call time', async () => {
    let root = '/virtual/first';
    const tools = new WorkspaceTools(() => root, {
      async readFile() {
        throw new Error('unused');
      },
      async listDirectory() {
        return [];
      },
    });

    expect((await tools.getWorkspaceContext()).output).to.contain('Workspace root: /virtual/first');
    root = '/virtual/second';
    expect((await tools.getWorkspaceContext()).output).to.contain('Workspace root: /virtual/second');
  });

  test('project intelligence resolves the root name at inspection time', async () => {
    let rootName = 'first';
    const intelligence = new ProjectIntelligenceService({
      rootName: () => rootName,
      async listEntries() {
        return [];
      },
      async readText() {
        return undefined;
      },
      async retrieve() {
        throw new Error('unused');
      },
    });
    const token = {
      isCancellationRequested: false,
      onCancellationRequested() {
        return { dispose() {} };
      },
    };

    expect((await intelligence.inspect(token)).rootName).to.equal('first');
    rootName = 'second';
    expect((await intelligence.inspect(token)).rootName).to.equal('second');
  });

  test('orchestrator sessions capture the root selected at start time', async () => {
    let root = '/virtual/first';
    const unused = async (): Promise<never> => {
      throw new Error('unused');
    };
    const controller = new AgentOrchestrator({
      workspaceRoot: () => root,
      complete: unused,
      inspect: unused,
      retrieve: unused,
      changes: { prepare: unused, apply: unused, undo: unused },
      runCommand: unused,
      agentSettings: () => {
        throw new Error('unused');
      },
      commandSettings: () => {
        throw new Error('unused');
      },
    });
    const cancelledToken = {
      isCancellationRequested: true,
      onCancellationRequested() {
        return { dispose() {} };
      },
    };

    const first = await controller.start('first requirement', cancelledToken);
    expect(first.workspaceRoot).to.equal('/virtual/first');
    root = '/virtual/second';
    const second = await controller.start('second requirement', cancelledToken);
    expect(second.workspaceRoot).to.equal('/virtual/second');
  });
});
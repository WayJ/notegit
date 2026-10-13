import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_WATERMARK_THRESHOLDS,
  DISK_DOMAINS,
  evaluateWatermark,
  scanDiskUsage,
} from '../src/metrics/disk.ts';

// S8-T2 磁盘水位（架构 §10「磁盘容量」/backup §2 四分域）：/data 分域用量扫描 +
// 水位判定（ok/warn/critical + alert 标志）。磁盘填充告警断言：注入用量（确定性
// 比值）与 tmp 目录 + 微阈值（真实扫描跨阈值）两形态。

test('分域用量：四分域逐目录递归求和，缺失域如实为 0，非分域内容不计入', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-metrics-disk-'));
  try {
    await mkdir(path.join(dataDir, 'git', '1.git', 'objects'), { recursive: true });
    await writeFile(path.join(dataDir, 'git', '1.git', 'objects', 'pack'), 'x'.repeat(1000));
    await writeFile(path.join(dataDir, 'git', '1.git', 'HEAD'), 'x'.repeat(100));
    await mkdir(path.join(dataDir, 'db'), { recursive: true });
    await writeFile(path.join(dataDir, 'db', 'notegit.sqlite'), 'y'.repeat(300));
    await mkdir(path.join(dataDir, 'config'), { recursive: true });
    await writeFile(path.join(dataDir, 'config', 'f'), 'z'.repeat(40));
    // keys/ 缺失 → 0；stray/ 不属四分域 → 不计入
    await mkdir(path.join(dataDir, 'stray'), { recursive: true });
    await writeFile(path.join(dataDir, 'stray', 'junk'), 'q'.repeat(999));

    const usage = await scanDiskUsage(dataDir);
    const byName = new Map(usage.domains.map((d) => [d.name, d.usedBytes]));
    assert.deepEqual(
      usage.domains.map((d) => d.name).sort(),
      [...DISK_DOMAINS].sort(),
      '域清单 = backup §2 四分域',
    );
    assert.equal(byName.get('git'), 1100);
    assert.equal(byName.get('db'), 300);
    assert.equal(byName.get('config'), 40);
    assert.equal(byName.get('keys'), 0, '缺失域如实为 0');
    assert.ok((usage.capacityBytes ?? 0) > 0, '容量来自 statfs（真实文件系统）');
    assert.ok((usage.freeBytes ?? 0) > 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('水位判定：注入用量下比值与阈值数学确定（ok/warn/critical 三档）', () => {
  const at = (used: number, capacity: number) => ({ capacityBytes: capacity, freeBytes: capacity - used });
  // 0.9 ≥ critical 0.90 → critical；0.85 ≥ warn → warn；0.5 → ok
  assert.equal(evaluateWatermark(at(900, 1000)).level, 'critical');
  assert.equal(evaluateWatermark(at(850, 1000)).level, 'warn');
  assert.equal(evaluateWatermark(at(500, 1000)).level, 'ok');
  const w = evaluateWatermark(at(850, 1000));
  assert.equal(w.used_ratio, 0.85);
  assert.equal(w.alert, true, 'warn 即告警');
  assert.equal(evaluateWatermark(at(500, 1000)).alert, false);
  assert.equal(w.warn_ratio, DEFAULT_WATERMARK_THRESHOLDS.warn);
  assert.equal(w.critical_ratio, DEFAULT_WATERMARK_THRESHOLDS.critical);
});

test('磁盘填充告警（真实扫描形态）：tmp 写入后微阈值触发 warn/critical，不可能阈值保持 ok', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-metrics-fill-'));
  try {
    await mkdir(path.join(dataDir, 'git'), { recursive: true });
    await writeFile(path.join(dataDir, 'git', 'filler'), 'f'.repeat(4096));
    const usage = await scanDiskUsage(dataDir);
    // 真实文件系统 used_ratio ∈ (0,1)：warn 阈值取 1e-9 必跨 → warn（critical 抬到不可达）
    const warnHit = evaluateWatermark(usage, { warn: 1e-9, critical: 0.999999 });
    assert.equal(warnHit.level, 'warn');
    assert.equal(warnHit.alert, true);
    // 两档都取微阈值 → critical（磁盘填充到极限的等价注入）
    const criticalHit = evaluateWatermark(usage, { warn: 1e-9, critical: 1e-9 });
    assert.equal(criticalHit.level, 'critical');
    // 阈值抬到 >1（比值不可达）→ ok
    const ok = evaluateWatermark(usage, { warn: 1.5, critical: 1.9 });
    assert.equal(ok.level, 'ok');
    assert.equal(ok.alert, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('容量不可知（注入 null）：level unknown、不告警——不伪造比值', () => {
  const w = evaluateWatermark({ capacityBytes: null, freeBytes: null });
  assert.equal(w.used_ratio, null);
  assert.equal(w.level, 'unknown');
  assert.equal(w.alert, false);
});

test('空目录形态：四分域全 0，扫描不抛错', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-metrics-empty-'));
  try {
    const usage = await scanDiskUsage(dataDir);
    assert.equal(usage.domains.length, DISK_DOMAINS.length);
    for (const d of usage.domains) assert.equal(d.usedBytes, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

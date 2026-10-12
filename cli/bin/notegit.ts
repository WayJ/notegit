#!/usr/bin/env node
/** notegit CLI 入口：解析参数并分发子命令（架构 §8.1；S6-T1 骨架，实现随 S6-T2+ 落地）。 */
import process from 'node:process'
import { run } from '../src/main.ts'

process.exitCode = run(process.argv.slice(2))

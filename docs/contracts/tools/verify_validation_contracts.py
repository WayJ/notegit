#!/usr/bin/env python3
"""Notegit 统一内容校验契约自检门禁（S1-T2）。

用法：
    python3 docs/contracts/tools/verify_validation_contracts.py

依赖：python3 >= 3.9；jsonschema >= 4（pip3 install --user jsonschema）。
退出码：0 = 全部检查通过；1 = 存在 FAIL；2 = 依赖缺失。

检查项：
  1. schemas/*.json 为合法 JSON 且通过 JSON Schema 2020-12 元校验；
  2. examples/report-*.json 全部通过 schemas/validation-report.schema.json；
  3. examples/frontmatter-cases.json：kind=object 用例按 expect 通过/不通过
     schemas/frontmatter.schema.json；kind=raw 用例仅做注册表核对
     （YAML 层规则无法用 JSON 表达，留给实现方测试覆盖）；
  4. 交叉一致性：
     a. 示例中出现的每个错误码（含报告顶层 issues 与 notices）都在 validation.md 错误码注册表内；
     b. 注册表每行 severity 与码前缀一致（E=error / W=warning / N=info）；
     b2. 注册表退出码列一致（W/N→0、E-RUN-*→2、其余 E→1）；
     c. 所有报告示例的 rulesVersion == rules-version.json 的 rulesVersion，
        且该版本号出现在 validation.md 中；
     d. validation-defaults.json 的每个默认值与 validation.md 默认值表一致（双向）；
     e. 报告示例 result 与 exitCode 映射正确（pass→0 / fail→1 / error→2），
        summary 算术一致（filesTotal=filesPassed+filesFailed=len(files)，
        errorCount/warningCount 与 issues 实算一致）；
     f. rules-version.json 的 artifacts 所列文件都存在；
  5. result=fail 或 error 的报告示例中所有 refs[].outcome == "rejected"
     （push 全有或全无，架构 §5.4）。

validation.md 表格式约定（本脚本的解析契约）：
  - 错误码注册表行：`| <code> | <rule id> | <severity> | ... |`（severity 固定第 3 列）；
  - 默认值表行：`| \`validation.*\` | <默认值：整数或 JSON 数组字符串> | ... |`。
"""
import json
import re
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError:  # pragma: no cover
    print("[FAIL] 缺少依赖 jsonschema：pip3 install --user jsonschema")
    sys.exit(2)

CONTRACTS = Path(__file__).resolve().parents[1]  # docs/contracts/
SCHEMA_DIR = CONTRACTS / "schemas"
EXAMPLE_DIR = CONTRACTS / "examples"
VALIDATION_MD = CONTRACTS / "validation.md"
RULES_VERSION = CONTRACTS / "rules-version.json"
DEFAULTS_JSON = CONTRACTS / "validation-defaults.json"

CODE_RE = re.compile(r"^(E|W|N)-[A-Z]+-\d{3}$")
PREFIX_SEVERITY = {"E": "error", "W": "warning", "N": "info"}
RESULT_EXIT = {"pass": 0, "fail": 1, "error": 2}

results = []  # (name, ok, detail)


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def parse_md_tables(md_text):
    """返回 (注册表行, 默认值表行)。单元格去掉首尾空白与反引号。

    注册表行格式：`| <code> | <rule id> | <severity> | <退出码> | ... |`；
    默认值表行格式：`| validation.* | <默认值：整数或 JSON 数组字符串> | ... |`。
    """
    registry = []   # (code, severity, exit_code_cell)
    defaults = []   # (config_key, raw_value)
    for line in md_text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [c.strip().strip("`") for c in stripped.strip("|").split("|")]
        if len(cells) < 3:
            continue
        if CODE_RE.match(cells[0]):
            registry.append((cells[0], cells[2], cells[3] if len(cells) > 3 else ""))
        elif cells[0].startswith("validation."):
            defaults.append((cells[0], cells[1]))
    return registry, defaults


def main():
    # ---- 1. Schema 文件存在且为合法 2020-12 schema ----
    schema_files = sorted(SCHEMA_DIR.glob("*.json")) if SCHEMA_DIR.is_dir() else []
    check("schemas: 目录下存在 schema 文件", len(schema_files) >= 2,
          f"找到 {[p.name for p in schema_files]}")
    schemas = {}
    for path in schema_files:
        try:
            schema = load_json(path)
            Draft202012Validator.check_schema(schema)
            schemas[path.name] = schema
            check(f"schemas: {path.name} 通过 2020-12 元校验", True)
        except Exception as exc:  # noqa: BLE001 - 门禁需要汇总而非中断
            check(f"schemas: {path.name} 通过 2020-12 元校验", False, str(exc))

    # ---- 2. 报告示例校验 ----
    report_schema = schemas.get("validation-report.schema.json")
    report_examples = sorted(EXAMPLE_DIR.glob("report-*.json")) if EXAMPLE_DIR.is_dir() else []
    check("examples: 存在 >=3 个 report 示例", len(report_examples) >= 3,
          f"找到 {[p.name for p in report_examples]}")
    for path in report_examples:
        try:
            doc = load_json(path)
            if report_schema is None:
                check(f"examples: {path.name} 通过报告 schema", False, "缺少 validation-report.schema.json")
            else:
                errors = sorted(Draft202012Validator(report_schema).iter_errors(doc),
                                key=lambda e: list(e.path))
                check(f"examples: {path.name} 通过报告 schema", not errors,
                      "; ".join(f"{list(e.path)}: {e.message}" for e in errors[:3]))
        except Exception as exc:  # noqa: BLE001
            check(f"examples: {path.name} 通过报告 schema", False, str(exc))

    # ---- 3. frontmatter 用例 ----
    fm_schema = schemas.get("frontmatter.schema.json")
    fm_cases_path = EXAMPLE_DIR / "frontmatter-cases.json"
    if fm_cases_path.is_file():
        try:
            cases_doc = load_json(fm_cases_path)
            cases = cases_doc.get("cases", [])
            check("frontmatter-cases: 存在用例", len(cases) >= 10, f"共 {len(cases)} 例")
            for case in cases:
                name = case.get("name", "<未命名>")
                kind = case.get("kind")
                expect = case.get("expect")
                fm = case.get("frontmatter")
                if kind == "object":
                    if fm_schema is None:
                        check(f"frontmatter-cases: {name}", False, "缺少 frontmatter.schema.json")
                        continue
                    valid = Draft202012Validator(fm_schema).is_valid(fm)
                    ok = valid if expect == "valid" else not valid
                    check(f"frontmatter-cases: {name} (expect {expect})", ok)
                elif kind == "raw":
                    check(f"frontmatter-cases: {name} (raw 仅注册表核对，见 4a)", True)
                else:
                    check(f"frontmatter-cases: {name} kind 合法", False, f"kind={kind}")
        except Exception as exc:  # noqa: BLE001
            check("frontmatter-cases: 文件可解析", False, str(exc))
    else:
        check("frontmatter-cases: 文件存在", False, str(fm_cases_path))

    # ---- 4. 交叉一致性 ----
    md_text = VALIDATION_MD.read_text(encoding="utf-8") if VALIDATION_MD.is_file() else ""
    registry, default_rows = parse_md_tables(md_text)
    codes = {c for c, _severity, _exit in registry}
    check("validation.md: 注册表存在", len(registry) >= 20, f"共 {len(registry)} 行")
    check("validation.md: 注册表码唯一", len(codes) == len(registry))
    for code, severity, _exit_cell in registry:
        check(f"registry: {code} severity 前缀一致",
              PREFIX_SEVERITY.get(code[0]) == severity, f"{code} -> {severity}")
    # 注册表退出码列：W/N→0；E-RUN-*→2；其余 E→1（架构 §5.4）
    bad_exit = []
    for code, _severity, exit_cell in registry:
        expected_exit = 0 if code[0] in "WN" else (2 if code.startswith("E-RUN-") else 1)
        try:
            actual_exit = int(exit_cell)
        except ValueError:
            actual_exit = None
        if actual_exit != expected_exit:
            bad_exit.append(f"{code}: 表列 {exit_cell!r} ≠ 期望 {expected_exit}")
    check("registry: 退出码列一致（W/N→0、E-RUN→2、其余 E→1）", not bad_exit,
          "; ".join(bad_exit[:3]))

    # 4a. 示例中的码都在注册表内
    used_codes = set()
    for path in report_examples:
        try:
            doc = load_json(path)
            for f_entry in doc.get("files", []):
                used_codes.update(i.get("code") for i in f_entry.get("issues", []))
            used_codes.update(i.get("code") for i in doc.get("issues", []))
            used_codes.update(n.get("code") for n in doc.get("notices", []))
        except Exception:  # noqa: BLE001 - 解析失败已由检查 2 覆盖
            continue
    if fm_cases_path.is_file():
        try:
            for case in load_json(fm_cases_path).get("cases", []):
                used_codes.update(case.get("expectedCodes", []))
        except Exception:  # noqa: BLE001
            pass
    missing = sorted(c for c in used_codes if c and c not in codes)
    check("registry: 示例用到的码全部注册", not missing, f"缺失 {missing}")

    # 4b/4c/4e/5. 报告示例内部一致性
    rules_version_value = None
    if RULES_VERSION.is_file():
        try:
            rules_version_value = load_json(RULES_VERSION).get("rulesVersion")
            if rules_version_value and md_text:
                check("validation.md: 规则版本与 manifest 一致（版本号出现在文档中）",
                      rules_version_value in md_text,
                      f"{rules_version_value} 未出现在 validation.md")
        except Exception as exc:  # noqa: BLE001
            check("rules-version.json: 可解析", False, str(exc))
    else:
        check("rules-version.json: 文件存在", False, str(RULES_VERSION))

    for path in report_examples:
        try:
            doc = load_json(path)
        except Exception:  # noqa: BLE001
            continue
        name = path.name
        if rules_version_value is not None:
            check(f"{name}: rulesVersion 等于 manifest",
                  doc.get("rulesVersion") == rules_version_value,
                  f"{doc.get('rulesVersion')} != {rules_version_value}")
        result, exit_code = doc.get("result"), doc.get("exitCode")
        check(f"{name}: result/exitCode 映射", RESULT_EXIT.get(result) == exit_code,
              f"{result}/{exit_code}")
        if result in ("fail", "error"):
            outcomes = {r.get("outcome") for r in doc.get("refs", [])}
            check(f"{name}: fail|error ⇒ refs 全部 rejected", outcomes <= {"rejected"},
                  f"outcomes={outcomes}")
        # summary 算术：filesTotal = filesPassed + filesFailed；error/warning 计数与 issues 一致
        files = doc.get("files", [])
        err_n = sum(1 for f_entry in files for i in f_entry.get("issues", [])
                    if i.get("severity") == "error")
        err_n += sum(1 for i in doc.get("issues", []) if i.get("severity") == "error")
        warn_n = sum(1 for f_entry in files for i in f_entry.get("issues", [])
                     if i.get("severity") == "warning")
        warn_n += sum(1 for i in doc.get("issues", []) if i.get("severity") == "warning")
        summary = doc.get("summary", {})
        arith_ok = (summary.get("filesTotal") == summary.get("filesPassed") + summary.get("filesFailed")
                    and summary.get("filesTotal") == len(files)
                    and summary.get("errorCount") == err_n
                    and summary.get("warningCount") == warn_n)
        check(f"{name}: summary 算术一致", arith_ok,
              f"summary={summary} 实算 files={len(files)} err={err_n} warn={warn_n}")

    # 4d. 默认值双向一致
    if DEFAULTS_JSON.is_file():
        try:
            defaults_doc = load_json(DEFAULTS_JSON)
            json_defaults = {}
            for group in ("adminConfigurable", "runtime"):
                for key, spec in defaults_doc.get(group, {}).items():
                    json_defaults[key] = spec.get("default")
            doc_defaults = {}
            for key, raw in default_rows:
                try:
                    doc_defaults[key] = int(raw)
                except ValueError:
                    try:
                        doc_defaults[key] = json.loads(raw)
                    except Exception:  # noqa: BLE001
                        doc_defaults[key] = raw
            only_json = sorted(set(json_defaults) - set(doc_defaults))
            only_doc = sorted(set(doc_defaults) - set(json_defaults))
            value_diff = {k: (json_defaults[k], doc_defaults[k])
                          for k in set(json_defaults) & set(doc_defaults)
                          if json_defaults[k] != doc_defaults[k]}
            check("defaults: JSON 与 validation.md 键一致",
                  not only_json and not only_doc, f"仅JSON {only_json} / 仅文档 {only_doc}")
            check("defaults: JSON 与 validation.md 值一致", not value_diff, str(value_diff))
            check("defaults: 文档默认值表存在", len(doc_defaults) >= 8, f"共 {len(doc_defaults)} 行")
        except Exception as exc:  # noqa: BLE001
            check("validation-defaults.json: 可解析", False, str(exc))
    else:
        check("validation-defaults.json: 文件存在", False, str(DEFAULTS_JSON))

    # 4f. artifacts 文件存在
    if RULES_VERSION.is_file() and rules_version_value is not None:
        try:
            artifacts = load_json(RULES_VERSION).get("artifacts", {})
            absent = [v for v in artifacts.values() if not (CONTRACTS / v).is_file()]
            check("rules-version.json: artifacts 文件齐全", not absent, f"缺失 {absent}")
        except Exception as exc:  # noqa: BLE001
            check("rules-version.json: artifacts 可读取", False, str(exc))

    # ---- 汇总 ----
    failed = [(n, d) for n, ok, d in results if not ok]
    for name, ok, detail in results:
        mark = "PASS" if ok else "FAIL"
        suffix = f"  [{detail}]" if (detail and not ok) else ""
        print(f"[{mark}] {name}{suffix}")
    total, fail_n = len(results), len(failed)
    print(f"\n检查结果：{total - fail_n}/{total} 通过，{fail_n} 失败")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

"""Workbook rules, pure calculations, and cross-ledger validation.

Amounts use Decimal / ROUND_HALF_UP. All dates are ISO business dates in Asia/Shanghai.
"""

from __future__ import annotations
from copy import deepcopy
from datetime import date, timedelta, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, ROUND_FLOOR, ROUND_DOWN, localcontext
from pathlib import Path
from zoneinfo import ZoneInfo
import json

ROOT = Path(__file__).parent
SCHEMA = json.loads((ROOT / "schema.json").read_text())
ORDER = ["skus", "exports", "receipts", "sales", "taxes", "exceptions", "documents"]
PRE = "未售-海外仓预退（HWC-YT）"
NORMAL = "已售-按现行规定申报"
DEFAULT_SETTINGS = dict(
    company_name="我的企业",
    company_type="外贸企业",
    shop_name="",
    tax_authority="",
    filing_date="",
    warning_days=60,
    evidence_days=15,
    retention_years=10,
    deadline_month=4,
    deadline_day=30,
)


class RuleError(ValueError):
    pass


def today_cn():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


def dec(value):
    return Decimal(str(value or 0))


def money(value):
    return float(dec(value).quantize(Decimal(".01"), rounding=ROUND_HALF_UP))


def total(rows, key):
    return sum((dec(r.get(key)) for r in rows), Decimal(0))


def allocate_money(amount, weights, denominator=None):
    """Round proportional allocations to cents using largest remainders.

    Negative refund rows retain their sign; a separate denominator allows a
    settlement to have sales that are not yet completely allocated.
    """
    with localcontext() as ctx:
        ctx.prec = 50
        divisor = sum(map(dec, weights), Decimal(0)) if denominator is None else dec(denominator)
        if not weights or divisor <= 0:
            return [0.0] * len(weights)
        numerators = [dec(amount) * 100 * dec(weight) for weight in weights]
        cents = [(value / divisor).to_integral_value(rounding=ROUND_FLOOR) for value in numerators]
        numerator_total = sum(numerators, Decimal(0))
        target = (numerator_total / divisor).to_integral_value(rounding=ROUND_DOWN)
        remainder = numerator_total - target * divisor
        if abs(remainder) * 2 >= divisor:
            target += -1 if numerator_total < 0 else 1
        remaining = int(target - sum(cents, Decimal(0)))
        order = sorted(range(len(cents)), key=lambda i: (-(numerators[i] - cents[i] * divisor), i))
        for i in order[:remaining]:
            cents[i] += 1
        return [float(value / 100) if value else 0.0 for value in cents]


def present(value):
    return value is not None and value != ""


def as_date(value):
    return date.fromisoformat(str(value)) if present(value) else None


def add_years(value, years):
    d = as_date(value)
    if not d:
        return None
    try:
        return d.replace(year=d.year + years).isoformat()
    except ValueError:
        return d.replace(year=d.year + years, day=28).isoformat()


def deadline(value, settings):
    d = as_date(value)
    return (
        date(d.year + 1, settings["deadline_month"], settings["deadline_day"]).isoformat()
        if d
        else None
    )


def clean(kind, payload):
    if kind not in SCHEMA or not isinstance(payload, dict):
        raise RuleError("不支持的台账或数据格式")
    result = {}
    for f in SCHEMA[kind]["fields"]:
        if f["computed"]:
            continue
        key, value = f["key"], payload.get(f["key"])
        if not present(value):
            if f["required"]:
                raise RuleError(f"{f['label']}为必填项")
            continue
        try:
            if f["type"] in ("number", "integer"):
                n = Decimal(str(value))
                if not n.is_finite() or abs(n) > Decimal("1000000000000"):
                    raise ValueError()
                if f["type"] == "integer":
                    if n != n.to_integral_value():
                        raise ValueError()
                    value = int(n)
                else:
                    if max(0, -n.normalize().as_tuple().exponent) > 8:
                        raise ValueError()
                    value = format(n.normalize(), "f") if n else "0"
            elif f["type"] == "date":
                value = date.fromisoformat(str(value)).isoformat()
                if kind == "sales" and key == "month":
                    value = value[:8] + "01"
            else:
                value = str(value).strip()
                if len(value) > 2000 or (f["required"] and not value):
                    raise ValueError()
        except (ValueError, InvalidOperation, TypeError):
            raise RuleError(f"{f['label']}格式不正确（数值最多 8 位小数）") from None
        if f.get("options") and value not in f["options"]:
            raise RuleError(f"{f['label']}不在允许选项中")
        result[key] = value
    for key in ("quantity", "received_qty", "sold_qty", "returned_qty", "item_no"):
        if key in result and dec(result[key]) < 0 and kind != "taxes":
            raise RuleError(f"{key} 不得小于 0")
    if kind == "skus" and not 0 <= dec(result.get("tax_rate")) <= 1:
        raise RuleError("退税率应在 0 到 1 之间")
    if kind == "exports":
        if result["item_no"] < 1 or result["quantity"] <= 0:
            raise RuleError("项号和报关数量必须大于 0")
        result.setdefault("trade_mode", "9810")
        if result["trade_mode"] != "9810":
            raise RuleError("本台账仅适用于 9810 监管方式")
    if "exchange_rate" in result and dec(result["exchange_rate"]) <= 0:
        raise RuleError("汇率必须大于 0")
    if (
        kind == "taxes"
        and result["method"] == PRE
        and (result["quantity"] <= 0 or dec(result["amount"]) < 0)
    ):
        raise RuleError("预退税申报数量须大于 0，金额不得为负")
    if kind == "receipts":
        if (
            result.get("period_start")
            and result.get("period_end")
            and result["period_end"] < result["period_start"]
        ):
            raise RuleError("结算结束日期不得早于开始日期")
        if present(result.get("received_amount")) and not result.get("received_date"):
            raise RuleError("填写入境金额时必须同时填写境内银行入账日期")
        if result.get("received_date") and not present(result.get("received_amount")):
            raise RuleError("填写境内银行入账日期时必须同时填写入境金额")
        if dec(result.get("received_amount")) < 0:
            raise RuleError("境内入账金额不得为负；退汇请在备注记录并调整原入账金额")
    date_pairs = {
        "exports": [("export_date", "received_date")],
        "sales": [("sale_date", "evidence_date")],
        "taxes": [("declaration_date", "completed_date"), ("completed_date", "reconciled_date")],
        "documents": [("declaration_date", "completed_date")],
    }
    labels = {f["key"]: f["label"] for f in SCHEMA[kind]["fields"]}
    for first, second in date_pairs.get(kind, []):
        if result.get(first) and result.get(second) and result[second] < result[first]:
            raise RuleError(f"{labels[second]}不得早于{labels[first]}")
    return result


def clean_settings(payload):
    s = {**DEFAULT_SETTINGS, **{k: v for k, v in payload.items() if k in DEFAULT_SETTINGS}}
    if s["company_type"] not in ["外贸企业", "生产企业"]:
        raise RuleError("企业类型无效")
    for k in ["company_name", "shop_name", "tax_authority", "filing_date"]:
        s[k] = str(s[k]).strip()
        if len(s[k]) > 200:
            raise RuleError("企业信息过长")
    if not s["company_name"]:
        raise RuleError("企业名称不能为空")
    if s["filing_date"]:
        try:
            as_date(s["filing_date"])
        except ValueError:
            raise RuleError("备案日期格式不正确") from None
    for k, low, high in [
        ("warning_days", 1, 365),
        ("evidence_days", 1, 90),
        ("retention_years", 1, 30),
        ("deadline_month", 1, 12),
        ("deadline_day", 1, 31),
    ]:
        try:
            n = int(s[k])
            if str(n) != str(s[k]) or not low <= n <= high:
                raise ValueError()
            s[k] = n
        except (ValueError, TypeError):
            raise RuleError(f"{k} 超出允许范围") from None
    try:
        date(2027, s["deadline_month"], s["deadline_day"])
    except ValueError:
        raise RuleError("截止日必须是每年都存在的日期") from None
    return s


def group_rows(rows, key):
    groups = {}
    for row in rows:
        groups.setdefault(row[key], []).append(row)
    return groups


def compute(data, settings=None, today=None):
    settings = {**DEFAULT_SETTINGS, **(settings or {})}
    today = today or today_cn()
    data = {kind: deepcopy(data.get(kind, [])) for kind in ORDER}
    sku_index = {r["sku"]: r for r in data["skus"]}
    sales_by_ledger = group_rows(data["sales"], "ledger_id")
    sales_by_settlement = group_rows(data["sales"], "settlement_id")
    taxes_by_ledger = group_rows(data["taxes"], "ledger_id")
    exceptions_by_ledger = group_rows(data["exceptions"], "ledger_id")
    documents_by_declaration = {r["declaration_no"]: r for r in data["documents"]}
    receipts_by_settlement = {r["settlement_id"]: r for r in data["receipts"]}
    exports = {}
    for r in data["exports"]:
        sku = sku_index.get(r["sku"], {})
        r.update(
            ledger_id=f"{r['declaration_no']}-{r['item_no']}",
            name=sku.get("name", "SKU未建档"),
            hs_code=sku.get("hs_code"),
            unit=sku.get("unit"),
            tax_rate=sku.get("tax_rate"),
        )
        r["fob_cny"] = money(dec(r["fob"]) * dec(r["exchange_rate"]))
        r["tax_basis"] = (
            r.get("invoice_amount") if settings["company_type"] == "外贸企业" else r["fob_cny"]
        )
        r["expected_tax"] = (
            money(dec(r["tax_basis"]) * dec(r["tax_rate"])) if present(r["tax_basis"]) else None
        )
        r["warehouse_difference"] = (
            int(r["received_qty"]) - int(r["quantity"]) if present(r.get("received_qty")) else None
        )
        exports[r["ledger_id"]] = r
    for r in data["sales"]:
        r["net_qty"] = int(r.get("sold_qty", 0)) - int(r.get("returned_qty", 0))
        r["net_amount"] = money(dec(r.get("gross")) - dec(r.get("fees")))
        r["sku_check"] = (
            "一致" if exports.get(r["ledger_id"], {}).get("sku") == r["sku"] else "SKU与报关单不符"
        )
        start, end = as_date(r.get("sale_date")), as_date(r.get("evidence_date"))
        r["evidence_status"] = (
            ("及时" if (end - start).days <= settings["evidence_days"] else "超期")
            if start and end
            else ("已超期未留存" if (today - start).days > settings["evidence_days"] else "待留存")
            if start
            else "未填写销售日期"
        )
        r["received_allocated"] = 0
        r["receipt_status"] = "待收汇"
    for r in data["receipts"]:
        r["net_amount"] = money(
            dec(r["gross"])
            - sum(
                (
                    dec(r.get(k))
                    for k in [
                        "commission",
                        "fulfillment",
                        "storage",
                        "advertising",
                        "refunds",
                        "other_fees",
                    ]
                ),
                Decimal(0),
            )
        )
        related = sales_by_settlement.get(r["settlement_id"], [])
        r["allocated"] = money(total(related, "net_amount"))
        r["allocation_difference"] = money(dec(r["net_amount"]) - dec(r["allocated"]))
        r["converted_amount"] = (
            money(dec(r.get("received_amount")) * dec(r.get("exchange_rate")))
            if present(r.get("received_amount")) and present(r.get("exchange_rate"))
            else None
        )
        received = (
            min(dec(r.get("received_amount")), max(Decimal(0), dec(r["net_amount"])))
            if r.get("received_date")
            else Decimal(0)
        )
        # Incomplete allocation is allowed while the settlement is being reconciled.
        # Over-allocation must never manufacture cash beyond the actual receipt.
        denominator = max(dec(r["net_amount"]), dec(r["allocated"]))
        ratio = received / denominator if denominator > 0 else Decimal(0)
        allocations = allocate_money(received, [s["net_amount"] for s in related], denominator)
        for s, allocated in zip(related, allocations):
            s["received_allocated"] = allocated
            s["receipt_status"] = "已收汇" if ratio >= 1 else "部分收汇" if ratio > 0 else "待收汇"
    tax_remaining = {}
    negative_normal_quantities = {}
    for ledger_id in exports:
        sold = total(sales_by_ledger.get(ledger_id, []), "net_qty")
        normal = total(
            [t for t in taxes_by_ledger.get(ledger_id, []) if t["method"] == NORMAL],
            "quantity",
        )
        tax_remaining[ledger_id] = max(Decimal(0), min(sold, sold - normal))
        if normal < 0:
            negative_normal_quantities[ledger_id] = normal
    # Stable input order is persisted and exported; generated record IDs are not.
    for r in sorted(data["taxes"], key=lambda r: r["declaration_date"]):
        e = exports.get(r["ledger_id"], {})
        r["sku"], r["export_date"] = e.get("sku"), e.get("export_date")
        r["receipt_deadline"] = deadline(e.get("export_date"), settings)
        r["difference"] = (
            money(dec(r.get("actual_amount")) - dec(r["amount"]))
            if present(r.get("actual_amount"))
            else None
        )
        r["deadline"] = (
            (r.get("deadline_override") or deadline(r.get("completed_date"), settings))
            if r["method"] == PRE
            else None
        )
        r["days_left"] = (
            (as_date(r["deadline"]) - today).days
            if r["deadline"] and not r.get("reconciled_date")
            else None
        )
        r["sold_qty"], r["reference_amount"], r["action"] = None, None, "按现行规定申报"
        if r["method"] == PRE:
            sold = min(dec(r["quantity"]), tax_remaining.get(r["ledger_id"], Decimal(0)))
            tax_remaining[r["ledger_id"]] = tax_remaining.get(r["ledger_id"], Decimal(0)) - sold
            r["sold_qty"] = int(sold)
            r["reference_amount"] = (
                money(dec(r["amount"]) / dec(r["quantity"]) * sold) if r["quantity"] else 0
            )
            r["action"] = (
                "仍未销售：需要调整申报，全额缴回预退税"
                if not sold
                else "部分已售：需要调整申报，全额冲减后按已售部分重报"
                if sold < dec(r["quantity"])
                else "全部已售：填写实际应退税额后判断"
                if r["difference"] is None
                else "全部已售、无差异：无需调整申报"
                if r["difference"] == 0
                else "全部已售、有差异：需要调整申报"
            )
        r["status"] = (
            "不涉及核算"
            if r["method"] != PRE
            else "已核算"
            if r.get("reconciled_date")
            else "待税务办结"
            if not r["deadline"]
            else "已逾期"
            if r["days_left"] < 0
            else "临近截止"
            if r["days_left"] <= settings["warning_days"]
            else "待核算"
        )
    for r in data["exceptions"]:
        r["sku"] = exports.get(r["ledger_id"], {}).get("sku")
    document_keys = [f["key"] for f in SCHEMA["documents"]["fields"] if 4 <= f["column"] <= 12]
    for r in data["documents"]:
        missing = sum(r.get(k) in (None, "", "未留存") for k in document_keys)
        pending = sum(r.get(k) == "陆续留存中" for k in document_keys)
        r["completeness"] = (
            f"缺{missing}项" if missing else f"留存中（{pending}项）" if pending else "齐全"
        )
        r["deadline"] = (
            as_date(r["declaration_date"]) + timedelta(days=settings["evidence_days"])
        ).isoformat()
        r["retention_date"] = add_years(r["declaration_date"], settings["retention_years"])
        completed = r.get("completed_date") if not missing and not pending else None
        r["timeliness"] = (
            ("按时" if completed <= r["deadline"] else "超期")
            if completed
            else ("已超期未完成" if today.isoformat() > r["deadline"] else "待完成")
        )
    ledger = []
    for e in data["exports"]:
        ss = sales_by_ledger.get(e["ledger_id"], [])
        ts = taxes_by_ledger.get(e["ledger_id"], [])
        ps = [t for t in ts if t["method"] == PRE]
        xs = exceptions_by_ledger.get(e["ledger_id"], [])
        ds = documents_by_declaration.get(e["declaration_no"])
        r = dict(e)
        r.update(
            net_sold=int(total(ss, "net_qty")),
            exception_qty=int(total(xs, "quantity")),
            net_revenue=money(total(ss, "net_amount")),
            received_amount=money(total(ss, "received_allocated")),
            declared_tax=money(total(ts, "amount")),
            prepaid_tax=money(total(ps, "amount")),
            receipt_deadline=deadline(e["export_date"], settings),
        )
        r["remaining"] = (
            int(e.get("received_qty", e["quantity"])) - r["net_sold"] - r["exception_qty"]
        )
        r["progress"] = round(r["net_sold"] / e["quantity"] * 100, 1)
        overdue = today.isoformat() > r["receipt_deadline"]
        r["receipt_status"] = (
            ("超过收汇期限仍未销售" if overdue else "尚未销售")
            if not r["net_sold"]
            else "已售部分已收汇"
            if r["received_amount"] >= r["net_revenue"]
            else "超期未收汇"
            if overdue
            else "有回款待收汇"
        )
        r["tax_status"] = next(
            (
                state
                for state in ["已逾期", "临近截止", "待税务办结", "待核算"]
                if any(t["status"] == state for t in ps)
            ),
            "已核算" if ps else "不涉及",
        )
        active_deadlines = [
            t["deadline"] for t in ps if t.get("deadline") and not t.get("reconciled_date")
        ]
        r["tax_deadline"] = min(active_deadlines) if active_deadlines else None
        r["document_status"] = ds["completeness"] if ds else "未登记"
        alerts = []
        if overdue and r["receipt_status"] != "已售部分已收汇":
            alerts.append(("danger", "收汇超期"))
        if r["tax_status"] == "已逾期":
            alerts.append(("danger", "核算逾期"))
        if r["tax_status"] == "临近截止":
            alerts.append(("warning", "核算临近截止"))
        if r["document_status"] != "齐全":
            alerts.append(("warning", "单证" + r["document_status"]))
        if ds and ds["timeliness"] in ["超期", "已超期未完成"]:
            alerts.append(("danger", "单证留存超期"))
        if e.get("warehouse_difference"):
            alerts.append(("warning", f"入仓差异 {e['warehouse_difference']:+}"))
        if not present(e.get("received_qty")):
            alerts.append(("info", "待 FBA 签收"))
        if any(s["evidence_status"] in ["超期", "已超期未留存"] for s in ss):
            alerts.append(("warning", "销售佐证超期"))
        if any(x.get("tax_adjustment") == "待处理" for x in xs):
            alerts.append(("warning", "异常退税待处理"))
        negative_normal = negative_normal_quantities.get(e["ledger_id"])
        if negative_normal is not None:
            alerts.append((
                "warning",
                f"正常申报累计数量为 {negative_normal:f} 件，请核对冲减记录；"
                f"预退税可分配销量按实际净销量 {r['net_sold']} 件封顶",
            ))
        settlement_ids = {s["settlement_id"] for s in ss}
        linked = [receipts_by_settlement[key] for key in settlement_ids if key in receipts_by_settlement]
        if any(p["allocation_difference"] != 0 for p in linked):
            alerts.append(("warning", "结算分摊差异"))
        if len(linked) != len(settlement_ids):
            alerts.append(("warning", "结算报告未登记"))
        if any(dec(p.get("received_amount")) > dec(p["net_amount"]) for p in linked):
            alerts.append(("warning", "入账金额大于结算净额"))
        r["alerts"] = [{"level": level, "text": text} for level, text in alerts]
        ledger.append(r)
    currencies = {}
    by_currency = group_rows(ledger, "currency")
    for currency in sorted(by_currency):
        group = by_currency[currency]
        currencies[currency] = {
            "net_revenue": money(total(group, "net_revenue")),
            "received": money(total(group, "received_amount")),
            "pending": money(total(group, "net_revenue") - total(group, "received_amount")),
        }
    return dict(
        records=data,
        ledger=ledger,
        stats=dict(
            export_count=len(ledger),
            quantity=int(total(ledger, "quantity")),
            net_sold=int(total(ledger, "net_sold")),
            remaining=int(total(ledger, "remaining")),
            declared_tax=money(total(ledger, "declared_tax")),
            prepaid_tax=money(total(ledger, "prepaid_tax")),
            pending_tax=sum(
                r["tax_status"] in ["待税务办结", "待核算", "临近截止", "已逾期"] for r in ledger
            ),
            risk_count=sum(bool(r["alerts"]) for r in ledger),
            currencies=currencies,
        ),
    )


def validate_state(data, settings):
    def unique(kind, key):
        seen = set()
        for r in data[kind]:
            value = key(r)
            if value in seen:
                raise RuleError(f"{SCHEMA[kind]['label']}存在重复编号：{value}")
            seen.add(value)
        return seen

    skus = unique("skus", lambda r: r["sku"])
    export_map = {f"{e['declaration_no']}-{e['item_no']}": e for e in data["exports"]}
    unique("exports", lambda r: f"{r['declaration_no']}-{r['item_no']}")
    unique("receipts", lambda r: r["settlement_id"])
    unique("documents", lambda r: r["declaration_no"])
    receipts = {r["settlement_id"]: r for r in data["receipts"]}
    declarations = {e["declaration_no"] for e in data["exports"]}
    for e in data["exports"]:
        if e["sku"] not in skus:
            raise RuleError(f"请先建立 SKU 档案：{e['sku']}")
    for kind in ["sales", "taxes", "exceptions"]:
        for r in data[kind]:
            e = export_map.get(r["ledger_id"])
            if not e:
                raise RuleError(f"{SCHEMA[kind]['label']}引用的核销编号不存在：{r['ledger_id']}")
            if kind == "sales":
                if r["sku"] != e["sku"]:
                    raise RuleError("销售 SKU 与报关 SKU 不符")
                receipt = receipts.get(r["settlement_id"])
                if receipt and receipt["currency"] != e["currency"]:
                    raise RuleError("同一结算报告与所属报关单的币种必须一致")
                if r.get("site") and e.get("site") and r["site"] != e["site"]:
                    raise RuleError("销售站点与报关站点不符")
                if (
                    receipt
                    and receipt.get("site")
                    and e.get("site")
                    and receipt["site"] != e["site"]
                ):
                    raise RuleError("结算报告站点与报关站点不符")
    for r in data["documents"]:
        if r["declaration_no"] not in declarations:
            raise RuleError("单证留存引用的报关单不存在")
    result = compute(data, settings)
    for r in result["ledger"]:
        if r["remaining"] < 0:
            raise RuleError(f"{r['ledger_id']} 库存不足，超分配 {-r['remaining']} 件")
        if r["net_sold"] < 0:
            raise RuleError(f"{r['ledger_id']} 累计退货超过累计销量")
    return result

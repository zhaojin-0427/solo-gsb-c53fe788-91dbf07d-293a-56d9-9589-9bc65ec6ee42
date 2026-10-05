"""编排预览、原子发布、已发布地址表查询与 CSV 下载、现场地址核验。"""
from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .. import planner, verify
from ..database import get_db
from ..models import Plan
from ..services import get_config_version

router = APIRouter(prefix="/api/plans", tags=["plans"])


@router.get("/version")
def version(db: Session = Depends(get_db)):
    latest = planner.latest_published(db)
    return {
        "config_version": get_config_version(db),
        "latest_published_plan_id": latest.id if latest else None,
        "latest_published_at": latest.published_at if latest else None,
    }


@router.post("/preview")
def preview(db: Session = Depends(get_db)):
    return planner.create_preview(db)


# 注意：/published 必须声明在 /{plan_id} 之前，否则单段路径 "published"
# 会被 /{plan_id} 捕获并因无法解析为整数而返回 422
@router.get("/published")
def list_published(db: Session = Depends(get_db)):
    """全部已发布方案列表（新的在前），供现场核验选择任一版本。"""
    plans = (
        db.query(Plan)
        .filter(Plan.status == "published")
        .order_by(Plan.published_at.desc(), Plan.id.desc())
        .all()
    )
    return [
        {
            "plan_id": p.id,
            "config_version": p.config_version,
            "published_at": p.published_at,
            "migration_count": p.migration_count,
            "used_lines": p.used_lines,
        }
        for p in plans
    ]


@router.get("/{plan_id}")
def get_plan(plan_id: int, db: Session = Depends(get_db)):
    return planner.get_plan_payload(db, plan_id)


@router.post("/{plan_id}/publish")
def publish(plan_id: int, db: Session = Depends(get_db)):
    return planner.publish_plan(db, plan_id)


@router.get("/published/latest")
def latest(db: Session = Depends(get_db)):
    plan = planner.latest_published(db)
    if plan is None:
        return {"has_published": False}
    payload = planner.get_plan_payload(db, plan.id)
    payload["has_published"] = True
    return payload


@router.get("/published/{plan_id}/csv")
def published_csv(plan_id: int, db: Session = Depends(get_db)):
    plan = db.get(Plan, plan_id)
    if plan is None or plan.status != "published":
        raise HTTPException(status_code=404, detail="该方案尚未发布")
    # 与已发布查询同一路径：优先从快照还原；旧库无快照时按字段来源裁决重建，
    # 保证页面地址表与 CSV 内容一致——未知字段写“未知”，不得写成“否”
    payload = planner.get_plan_payload(db, plan_id)

    def _name_cell(a: dict) -> str:
        # 无快照旧记录的名称是当前值，须在 CSV 中标注来源（列保持不变）
        src = a.get("name_source")
        if src == "current":
            return f"{a['name']}（当前名称）"
        if src == "unavailable":
            return f"{a['name']}（名称不可用）"
        return a["name"]

    def _locked_cell(a: dict) -> str:
        # 历史锁定状态无法还原时为 None：写“未知”而非“否”
        if a.get("locked") is None:
            return "未知"
        return "是" if a["locked"] else "否"

    buf = io.StringIO()
    buf.write("﻿")
    writer = csv.writer(buf)
    writer.writerow(["灯具ID", "灯具名称", "线路", "起始地址", "结束地址", "通道数", "是否迁移", "是否锁定"])
    for a in payload["allocations"]:
        writer.writerow(
            [
                a["fixture_id"],
                _name_cell(a),
                a["line_id"],
                a["start"],
                a["end"],
                a["channels"],
                "是" if a["migrated"] else "否",
                _locked_cell(a),
            ]
        )
    buf.seek(0)
    filename = f"dmx_addresses_plan{plan_id}_v{payload['config_version']}.csv"
    return StreamingResponse(
        buf,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{plan_id}/verify")
async def verify_on_site(plan_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """现场地址核验：上传现场 CSV，与所选已发布方案的落点基准比对。

    基准取自发布快照（旧记录取留存明细），按灯具 ID 对齐计算闭区间；
    坏行/非法线路/越过 512/重复 ID 的行被隔离后继续核对，但只要存在
    隔离行，整表结论绝不报“一致”。本端点只读，不修改编排与发布数据。
    """
    plan = db.get(Plan, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail=f"方案 #{plan_id} 不存在")
    if plan.status != "published":
        raise HTTPException(
            status_code=409,
            detail=f"方案 #{plan_id} 尚未发布（当前状态：{plan.status}），只能核验已发布方案",
        )
    # 与已发布查询/CSV 同源的基准：快照还原或旧记录按字段来源裁决重建（只读）
    payload = planner.get_plan_payload(db, plan_id)

    content = await file.read()
    try:
        valid_rows, quarantined = verify.parse_on_site_csv(content)
    except verify.CsvStructureError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    report = verify.verify_against_baseline(payload["allocations"], valid_rows, quarantined)
    report.update(
        {
            "plan_id": plan.id,
            "config_version": plan.config_version,
            "published_at": plan.published_at,
            "from_snapshot": payload.get("from_snapshot", False),
        }
    )
    # 旧记录缺少快照时透传字段来源说明：名称/锁定/保留区不参与裁决
    if payload.get("notice"):
        report["notice"] = payload["notice"]
        report["field_sources"] = payload.get("field_sources")
    return report

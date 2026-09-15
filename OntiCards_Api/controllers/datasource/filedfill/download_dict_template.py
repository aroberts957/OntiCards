"""
 @File: download_dict_template.py
 @Description: 下载数据库字段注释字典模板文件（dict_template.xlsx）
 @Author: 韩小豪 849631113@qq.com
 @Create: 2026-09-15 11:13
"""
import logging
import os
import shutil
from pathlib import Path
from urllib.parse import quote

from flask import Blueprint, Response, current_app
from flask_login import login_required
from flask_restful import Api, Resource

# 与 extract_field_data_by_excle.py 共用同一个 Blueprint / Api 即可，
# 避免新增重复蓝图/重复注册。后续如有需要可拆分为独立蓝图。
from controllers.datasource.filedfill.extract_field_data_by_excle import api as _excel_api

# 但为了不影响原模块的 api 引用语义，这里重新声明一个独立的 Blueprint & Api
# 仅用于本下载接口（保持模块自包含、可单独删除）
download_dict_template = Blueprint('download_dict_template', __name__)
download_api = Api(download_dict_template)

logger = logging.getLogger(__name__)

# 标记当前 worker 是否已完成初始化（避免每个请求都检查）
_initialized = False


def _fallback_template_path() -> Path:
    """
    返回代码包内附带的 fallback 模板路径。
    优先取环境变量指定的相对路径（本地开发），其次取本文件同目录。
    """
    from config import get_env

    raw = get_env('FIELDFILL_DICT_TEMPLATE_PATH')
    if raw and not Path(raw).is_absolute():
        # 相对路径：相对于项目根目录
        project_root = Path(__file__).resolve().parents[3]
        return project_root / raw

    # 默认 fallback：本文件同目录
    return Path(__file__).resolve().parent / 'dict_template.xlsx'


def _ensure_template_initialized(target_path: Path) -> None:
    """
    首次调用时：
      1. 若目标文件已存在 → 直接返回
      2. 若目标文件不存在但目录不存在 → 自动创建目录
      3. 从 fallback 路径复制模板到目标路径
    仅在首次请求时执行（worker 级别单次初始化）。
    """
    global _initialized

    if _initialized:
        return

    if target_path.exists():
        _initialized = True
        return

    # 目标文件不存在，尝试初始化
    fallback = _fallback_template_path()
    if not fallback.exists():
        logger.warning(
            f"[字典模板初始化] fallback 模板不存在，跳过自动复制: {fallback}"
        )
        _initialized = True
        return

    try:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(fallback, target_path)
        logger.info(
            f"[字典模板初始化] 已从 {fallback} 复制模板到 {target_path}"
        )
    except Exception as e:
        logger.error(
            f"[字典模板初始化] 复制模板失败: fallback={fallback}, target={target_path}, err={e}"
        )
    finally:
        _initialized = True


def _resolve_template_path() -> Path:
    """
    解析字典模板路径
    优先级：
      1. 环境变量 FIELDFILL_DICT_TEMPLATE_PATH（服务器上配置为绝对路径）
      2. config.py DEFAULTS 中的默认值（相对项目根的路径，本地开发用）
      3. 若相对路径不存在，则回退到当前文件同目录下的 dict_template.xlsx
    """
    from config import get_env

    raw = get_env('FIELDFILL_DICT_TEMPLATE_PATH')
    if not raw:
        # 兜底：与本文件同目录
        return Path(__file__).resolve().parent / 'dict_template.xlsx'

    p = Path(raw)
    if not p.is_absolute():
        # 相对路径：相对项目根目录
        # 本文件路径: <project_root>/controllers/datasource/filedfill/download_dict_template.py
        # parents[0]=filedfill/  parents[1]=datasource/  parents[2]=controllers/  parents[3]=project_root
        project_root = Path(__file__).resolve().parents[3]
        p = project_root / p
    return p


class DownloadDictTemplateApi(Resource):
    """下载字典模板文件

    GET /console/api/filedfill/dict_template/download
    返回 dict_template.xlsx 文件流。
    """

    @login_required
    def get(self):
        file_path = _resolve_template_path()

        # 首次访问时：如果配置的绝对路径下没有文件，自动从代码包复制
        _ensure_template_initialized(file_path)

        if not file_path.exists() or not file_path.is_file():
            current_app.logger.error(f"[下载字典模板] 文件不存在: {file_path}")
            return {
                "code": 404,
                "msg": f"字典模板文件不存在: {file_path}",
                "data": None
            }, 404

        download_filename = file_path.name  # 默认 dict_template.xlsx

        try:
            with open(file_path, 'rb') as f:
                file_data = f.read()
        except Exception as e:
            current_app.logger.error(f"[下载字典模板] 读取失败: {file_path}, err={e}")
            return {
                "code": 500,
                "msg": f"读取字典模板失败: {str(e)}",
                "data": None
            }, 500

        encoded_filename = quote(download_filename, safe='')
        content_disposition = (
            f'attachment; filename="{encoded_filename}"; '
            f'filename*=UTF-8\'\'{encoded_filename}'
        )

        return Response(
            file_data,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            headers={
                'Content-Disposition': content_disposition,
                'Content-Length': str(len(file_data)),
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        )


# 注册路由：方法级 path，会拼到 blueprint 的 url_prefix 之后
download_api.add_resource(
    DownloadDictTemplateApi,
    '/filedfill/dict_template/download'
)

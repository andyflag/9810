"""Optional Chromium smoke test. Starts an isolated temporary database and local server.

Build frontend first. Install requirements-browser.txt and Chromium before running.
Never connects to or modifies a production deployment.
"""

from pathlib import Path
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = Path(os.environ.get("SCREENSHOT_DIR", ROOT / "test-results/browser"))
BROWSER_EXECUTABLE = os.environ.get("BROWSER_EXECUTABLE") or (
    "/usr/bin/chromium" if Path("/usr/bin/chromium").exists() else None
)


def run():
    if not (ROOT / "frontend/dist/index.html").exists():
        raise RuntimeError("Run npm run build --prefix frontend first")
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base_url = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="9810-browser-") as data_dir:
        env = {**os.environ, "DATA_DIR": data_dir, "APP_ENV": "development"}
        server = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "backend.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--no-access-log",
            ],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base_url + "/api/health", timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("Preview server did not start")
            with sync_playwright() as p:
                browser = p.chromium.launch(
                    executable_path=BROWSER_EXECUTABLE, headless=True, args=["--no-sandbox"]
                )
                page = browser.new_page(
                    viewport={"width": 1512, "height": 1100}, device_scale_factor=1
                )
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(base_url)
                page.wait_for_load_state("networkidle")
                page.get_by_role("button", name="创建企业空间", exact=True).click()
                page.get_by_label("你的姓名").fill("演示管理员")
                page.get_by_label("企业名称").fill("星航出海科技")
                page.get_by_label("邮箱地址").fill(f"demo-{int(time.time())}@example.com")
                page.get_by_label("登录密码").fill("Browser-QA-only-9810")
                page.get_by_role("button", name="创建企业空间", exact=True).click()
                page.get_by_role("button", name="体验示例数据").wait_for()
                page.get_by_role("button", name="体验示例数据").click()
                page.get_by_text("1,500", exact=False).first.wait_for()
                page.locator(".toast").get_by_role("button", name="关闭通知").click()
                page.screenshot(
                    path=str(SCREENSHOTS / "dashboard.png"), full_page=True, animations="disabled"
                )
                page.set_viewport_size({"width": 390, "height": 844})
                expect(page.locator(".sidebar")).not_to_be_in_viewport()
                page.screenshot(
                    path=str(SCREENSHOTS / "mobile.png"), full_page=True, animations="disabled"
                )
                page.set_viewport_size({"width": 1512, "height": 1100})
                page.get_by_role("button", name="新建报关").click()
                page.get_by_role("dialog").wait_for()
                page.get_by_label("报关单号", exact=False).fill("QA-20261022")
                page.get_by_label("出口日期", exact=False).fill("2026-10-22")
                page.locator("#field-sku").select_option("DEMO-A01")
                page.get_by_label("报关数量", exact=False).fill("50")
                page.get_by_label("FOB总价（原币）", exact=False).fill("300")
                page.get_by_role("button", name="保存记录", exact=True).click()
                page.get_by_role("dialog").wait_for(state="hidden")
                page.get_by_text("QA-20261022-1", exact=False).first.wait_for()
                page.get_by_role("button", name="SKU 档案", exact=True).click()
                page.get_by_role("button", name="新增记录", exact=True).click()
                page.locator("#field-sku").fill("QA-C01")
                page.get_by_label("中文品名", exact=False).fill("测试收纳袋")
                page.get_by_role("button", name="保存记录", exact=True).click()
                page.get_by_role("dialog").wait_for(state="hidden")
                page.get_by_text("QA-C01", exact=True).first.wait_for()
                page.get_by_text("QA-C01", exact=True).first.click()
                page.get_by_label("中文品名", exact=False).fill("测试收纳袋-更新")
                page.get_by_role("button", name="保存记录", exact=True).click()
                page.get_by_role("dialog").wait_for(state="hidden")
                page.get_by_text("测试收纳袋-更新", exact=True).wait_for()
                page.get_by_text("QA-C01", exact=True).first.click()
                page.get_by_role("button", name="删除记录", exact=True).click()
                page.get_by_role("button", name="确认删除", exact=True).click()
                page.get_by_role("dialog").wait_for(state="hidden")
                assert page.get_by_text("QA-C01", exact=True).count() == 0
                page.get_by_role("button", name="工作台", exact=False).first.click()
                page.get_by_role("textbox", name="搜索台账").fill("NO-MATCH")
                page.get_by_text("没有符合条件的记录").wait_for()
                page.get_by_role("button", name="清除筛选").click()
                with page.expect_download() as download:
                    page.get_by_role("link", name="导出", exact=True).click()
                assert download.value.suggested_filename.endswith(".xlsx")
                page.set_viewport_size({"width": 390, "height": 844})
                expect(page.locator(".sidebar")).not_to_be_in_viewport()
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
                page.get_by_role("button", name="打开导航").click()
                page.locator("nav").get_by_role("button", name="单证留存").click()
                page.get_by_role("button", name="编辑", exact=True).first.click()
                page.get_by_role("dialog").wait_for()
                page.locator("input[type=file]").set_input_files(
                    {
                        "name": "QA-document.txt",
                        "mimeType": "text/plain",
                        "buffer": b"test document",
                    }
                )
                page.get_by_role("link", name="QA-document.txt", exact=False).wait_for()
                page.get_by_role("button", name="关闭", exact=True).click()
                page.reload()
                page.get_by_role("button", name="打开导航").wait_for()
                assert not errors, errors
                print(
                    json.dumps(
                        {
                            "browser_errors": errors,
                            "desktop": "1512x1100",
                            "mobile": "390x844",
                            "checks": [
                                "register",
                                "demo",
                                "create export",
                                "SKU create/edit/delete",
                                "search",
                                "export download",
                                "mobile menu",
                                "attachment upload",
                                "reload persistence",
                            ],
                        },
                        ensure_ascii=False,
                    )
                )
                browser.close()
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == "__main__":
    run()

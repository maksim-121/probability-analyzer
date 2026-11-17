"""
Открывает тестовую страницу в Chrome без окна и печатает итог (он записан в заголовок страницы).
Запуск:  python tests/run_selftest.py          — движок (selftest.html): сверка с Python и с точными ответами
         python tests/run_selftest.py uitest   — страница «как пользователь» (uitest.html)
Глазами: selftest.html можно открыть двойным щелчком. uitest.html — только в Chrome с флагом
--allow-file-access-from-files (иначе браузер не пустит тест внутрь фрейма со страницей).
"""
import html
import re
import subprocess
import sys
from pathlib import Path

CHROMES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "selftest"
    page = Path(__file__).resolve().parent / f"{name}.html"
    exe = next((c for c in CHROMES if Path(c).exists()), None)
    if not exe:
        sys.exit("Не найден Chrome или Edge")
    out = subprocess.run([exe, "--headless=new", "--disable-gpu", "--no-first-run",
                          "--allow-file-access-from-files", "--window-size=1400,1000",
                          "--virtual-time-budget=120000", "--dump-dom", page.as_uri()],
                         capture_output=True, timeout=300)
    dom = out.stdout.decode("utf-8", "replace")
    title = re.search(r"<title>(.*?)</title>", dom, re.S)
    text = html.unescape(title.group(1)) if title else "заголовок не найден"
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)
    for row in re.findall(r'<td class="bad">.*?</tr>', dom, re.S):          # selftest
        print("  ✗", html.unescape(re.sub(r"<[^>]+>", " ", row)).strip())
    for line in re.findall(r"^✗ .*$", html.unescape(dom), re.M):               # uitest
        print("  ", line)
    sys.exit(0 if text.startswith("PASS") else 1)


if __name__ == "__main__":
    main()

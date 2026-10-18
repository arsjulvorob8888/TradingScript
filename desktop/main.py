"""T-Investments style desktop shell for the carry strategy."""
import sys
import logging
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QTabWidget, QTableWidget, QTableWidgetItem, QLabel, QPushButton,
    QLineEdit, QTextEdit, QGroupBox, QFormLayout, QFrame, QHeaderView,
    QCheckBox, QMessageBox,
)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
import matplotlib.pyplot as plt
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg as FigureCanvas

from config import TOKEN, RELIABLE_BONDS, RELIABLE_FUTURES, STRATEGY_PARAMS
from strategy import CarryStrategy
from api_client import TBankClient
from market_data import snapshot, BOND_CANDIDATES, live_market, CREDIT_RATES, FALLBACK

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

STYLE = """
QMainWindow, QWidget { background: #F6F7F8; color: #333333; font-family: "Segoe UI"; font-size: 13px; }
QFrame#card { background: #FFFFFF; border: none; border-radius: 16px; }
QLabel#muted { color: #9299A2; }
QLabel#hero { font-size: 34px; font-weight: 700; color: #222222; }
QLabel#section { font-size: 18px; font-weight: 700; }
QPushButton#primary { background: #FFDD2D; color: #222222; border: none; border-radius: 12px; padding: 12px 18px; font-weight: 700; }
QPushButton#primary:hover { background: #F0C400; }
QPushButton#primary:pressed { background: #E0B400; }
QPushButton#ghost:hover { background: #E6E8EC; }
QPushButton#ghost:pressed { background: #D8DBE0; }
QPushButton#ghost { background: #FFFFFF; color: #222222; border: none; border-radius: 12px; padding: 12px 18px; }
QLineEdit { background: #FFFFFF; border: none; border-radius: 10px; padding: 8px 10px; }
QTabWidget::pane { border: none; }
QTabBar::tab { background: transparent; padding: 8px 16px; color: #9299A2; font-weight: 600; }
QTabBar::tab:selected { color: #222222; border-bottom: 2px solid #FFDD2D; }
QTableWidget { background: #FFFFFF; border: none; border-radius: 16px; gridline-color: #F2F3F5; }
QHeaderView::section { background: #FFFFFF; border: none; color: #9299A2; padding: 8px; }
QTextEdit { background: #FFFFFF; border: none; border-radius: 12px; }
"""

PAIR_TICKERS = {"USDRUBF", "CNYRUBF"}
MM_TICKERS = {"LQDT", "TMON"}
BOND_ISINS = {item["isin"] for item in BOND_CANDIDATES}


def money(value):
    if isinstance(value, dict):
        return float(value.get("units") or 0) + float(value.get("nano") or 0) / 1_000_000_000
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


class Card(QFrame):
    def __init__(self):
        super().__init__()
        self.setObjectName("card")
        self.body = QVBoxLayout(self)
        self.body.setContentsMargins(18, 16, 18, 16)
        self.body.setSpacing(6)


class Donut(FigureCanvas):
    def __init__(self):
        self.fig, self.ax = plt.subplots(figsize=(1.7, 1.7), dpi=100)
        super().__init__(self.fig)
        self.fig.patch.set_facecolor("#FFFFFF")
        self.fig.subplots_adjust(0, 0, 1, 1)
        self.setFixedSize(150, 150)

    def draw_shares(self, pairs, funds, bonds, center, empty=False):
        self.ax.clear()
        self.ax.set_facecolor("#FFFFFF")
        if empty or pairs + funds + bonds <= 0:
            sizes, colors = [1], ["#E6E8EC"]
            center = "0"
        else:
            sizes = [max(pairs, 0), max(funds, 0), max(bonds, 0)]
            colors = ["#FFDD2D", "#3B78F0", "#2A2A2A"]
            sizes = [value if value else 0.001 for value in sizes]
        self.ax.pie(sizes, startangle=90, colors=colors, wedgeprops={"width": 0.38, "edgecolor": "white", "linewidth": 2})
        self.ax.text(0, 0.06, center if not empty else "0", ha="center", va="center", fontsize=11, fontweight="bold", color="#1C1C1C")
        self.ax.set_aspect("equal")
        self.draw()


class FundingChart(FigureCanvas):
    def __init__(self):
        fig, self.ax = plt.subplots(figsize=(8, 3.2))
        super().__init__(fig)
        fig.patch.set_facecolor("#FFFFFF")
        self.ax.set_facecolor("#FFFFFF")
        data = snapshot()
        months = [name for name, _ in data["monthly"]["USDRUBF"]]
        self.ax.plot(months, [v for _, v in data["monthly"]["USDRUBF"]], color="#FFDD2D", linewidth=2.5, label="Доллар")
        self.ax.plot(months, [v for _, v in data["monthly"]["CNYRUBF"]], color="#4C8DFF", linewidth=2.5, label="Юань")
        self.ax.axhline(0, color="#DDDDDD", linewidth=1)
        self.ax.legend(frameon=False)
        self.ax.set_ylabel("% годовых")
        self.ax.tick_params(colors="#9299A2")
        for spine in self.ax.spines.values():
            spine.set_visible(False)
        self.draw()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Инвестиции")
        self.resize(1180, 780)
        self.strategy = CarryStrategy(dict(STRATEGY_PARAMS))
        self.client = None
        self.account_id = None
        self.auto_buy = False
        self.portfolio_rows = []
        self.init_ui()

    def init_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(22, 16, 22, 16)
        root.setSpacing(12)

        top = QHBoxLayout()
        brand = QLabel("Инвестиции")
        brand.setObjectName("section")
        top.addWidget(brand)
        top.addStretch()
        self.token_input = QLineEdit(TOKEN)
        self.token_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.token_input.setPlaceholderText("Токен Т-Инвестиций")
        self.token_input.setFixedWidth(280)
        connect = QPushButton("Подключить счёт")
        connect.setObjectName("ghost")
        connect.clicked.connect(self.connect_api)
        top.addWidget(self.token_input)
        top.addWidget(connect)
        root.addLayout(top)

        self.tabs = QTabWidget()
        self.tabs.addTab(self._home(), "Главная")
        self.tabs.addTab(self._strategy_tab(), "Стратегия")
        self.tabs.addTab(self._analytics_tab(), "Аналитика")
        root.addWidget(self.tabs)
        self.refresh_stats(False)

    def _home(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setSpacing(12)

        hero = Card()
        row = QHBoxLayout()
        left = QVBoxLayout()
        cap = QLabel("Портфель")
        cap.setObjectName("muted")
        self.hero_value = QLabel("— ₽")
        self.hero_value.setObjectName("hero")
        self.hero_sub = QLabel("Счёт не подключён. Показан план стратегии.")
        self.hero_sub.setObjectName("muted")
        self.hero_gap = QLabel("прогноз —")
        left.addWidget(cap)
        left.addWidget(self.hero_value)
        left.addWidget(self.hero_sub)
        left.addWidget(self.hero_gap)
        row.addLayout(left, 1)
        actions = QVBoxLayout()
        launch = QPushButton("Запустить стратегию")
        launch.setObjectName("primary")
        launch.clicked.connect(self.launch_strategy)
        refresh = QPushButton("Обновить")
        refresh.setObjectName("ghost")
        refresh.clicked.connect(lambda: self.refresh_stats(True))
        actions.addWidget(launch)
        actions.addWidget(refresh)
        actions.addStretch()
        row.addLayout(actions)
        hero.body.addLayout(row)
        layout.addWidget(hero)

        mid = QHBoxLayout()
        structure = Card()
        structure.body.addWidget(QLabel("План и факт"))
        rings = QHBoxLayout()
        self.donut = Donut()
        self.donut_fact = Donut()
        rings.addWidget(self._ring_box("План", self.donut))
        rings.addWidget(self._ring_box("Факт", self.donut_fact))
        structure.body.addLayout(rings)
        mid.addWidget(structure, 3)

        side = QVBoxLayout()
        side.setSpacing(8)
        self.card_pairs, self.pairs_value, self.pairs_hint = self._metric("Валютные пары", "#C9A400")
        self.card_mm, self.mm_value, self.mm_hint = self._metric("Денежный рынок", "#3B78F0")
        self.card_rub, self.rub_value, self.rub_hint = self._metric("Рублёвые облигации", "#2A2A2A")
        side.addWidget(self.card_pairs)
        side.addWidget(self.card_mm)
        side.addWidget(self.card_rub)
        mid.addLayout(side, 2)
        layout.addLayout(mid)

        self.positions = QTableWidget(0, 4)
        self.positions.setHorizontalHeaderLabels(["Инструмент", "Группа", "Доля", "Доходность"])
        self.positions.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.positions.verticalHeader().setVisible(False)
        self.positions.setShowGrid(False)
        self.positions.setMinimumHeight(220)
        layout.addWidget(self.positions)

        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setFixedHeight(72)
        layout.addWidget(self.log_text)
        return page

    def _ring_box(self, caption, donut):
        box = QWidget()
        column = QVBoxLayout(box)
        column.setContentsMargins(0, 0, 0, 0)
        label = QLabel(caption)
        label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        column.addWidget(label)
        column.addWidget(donut, alignment=Qt.AlignmentFlag.AlignCenter)
        return box

    def _metric(self, name, color):
        card = Card()
        dot = QLabel("●  " + name)
        dot.setStyleSheet(f"color: {color}; font-weight: 700;")
        value = QLabel("—")
        value.setObjectName("section")
        hint = QLabel("")
        hint.setObjectName("muted")
        card.body.addWidget(dot)
        card.body.addWidget(value)
        card.body.addWidget(hint)
        return card, value, hint

    def _strategy_tab(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        box = QGroupBox("Пороги")
        form = QFormLayout(box)
        self.cushion_yield = QLineEdit(str(STRATEGY_PARAMS["cushion_yield"]))
        self.carry_spread = QLineEdit(str(STRATEGY_PARAMS["carry_hurdle_spread"]))
        self.hedge_band = QLineEdit(str(STRATEGY_PARAMS["fx_rebalance_band"]))
        self.fx_extreme = QLineEdit(str(STRATEGY_PARAMS["fx_extreme"]))
        self.dip_thresh = QLineEdit(str(STRATEGY_PARAMS["bond_dip_threshold"]))
        form.addRow("Доходность подушки, %", self.cushion_yield)
        form.addRow("Пара должна быть выше на, п.п.", self.carry_spread)
        form.addRow("Починка хеджа, %", self.hedge_band)
        form.addRow("Аномалия курса за 60 дней, %", self.fx_extreme)
        form.addRow("Просадка тела облигации, %", self.dip_thresh)
        layout.addWidget(box)
        self.auto_box = QCheckBox("Разрешаю закуп из подушки без отдельного подтверждения")
        self.auto_box.toggled.connect(self._set_auto)
        layout.addWidget(self.auto_box)
        button = QPushButton("Показать, что сделает стратегия")
        button.setObjectName("primary")
        button.clicked.connect(self.evaluate_strategy)
        layout.addWidget(button)
        self.strategy_status = QTextEdit()
        self.strategy_status.setReadOnly(True)
        layout.addWidget(self.strategy_status)
        return page

    def _analytics_tab(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        self.analytics_text = QTextEdit()
        self.analytics_text.setReadOnly(True)
        layout.addWidget(FundingChart())
        layout.addWidget(self.analytics_text)
        return page

    def refresh_stats(self, live=False):
        market = live_market() if live else dict(FALLBACK)
        if not live:
            market["source"] = "снимок 16 октября 2026"
            market["lqdt_45"] = 14.43
            market["tmon_45"] = 13.44
        usd = self.strategy.net_carry(market["usd_ytm"], market["usd_funding"], market["usd_price"])
        cny = self.strategy.net_carry(market["cny_ytm"], market["cny_funding"], market["cny_price"])
        mm = max(market["lqdt"], market["tmon"])
        extreme = self.strategy.params.get("fx_extreme", 15)
        usd_weak = usd < mm or abs(market.get("usd_move", 0)) >= extreme
        cny_weak = cny < mm or abs(market.get("cny_move", 0)) >= extreme
        weights = self.strategy.weights(usd_weak, cny_weak)
        parts = {"usd": usd, "cny": cny, "rub": market["ofz"], "lqdt": market["lqdt"], "tmon": market["tmon"]}
        total = sum(weights[key] * parts[key] for key in weights)
        self.last_market = market
        self.last_carries = (usd, cny, mm)
        self.plan_weights = weights
        self.plan_parts = parts
        self.forecast = total

        plan_pairs = (weights["usd"] + weights["cny"]) * 100
        plan_funds = (weights["lqdt"] + weights["tmon"]) * 100
        plan_bonds = weights["rub"] * 100
        self.donut.draw_shares(plan_pairs, plan_funds, plan_bonds, f"{total:.1f}%")
        if actual["total"] > 0:
            pairs = actual["pairs"] / actual["total"] * 100
            funds = actual["funds"] / actual["total"] * 100
            bonds = actual["bonds"] / actual["total"] * 100
            self.hero_value.setText(f"{actual['total']:,.0f} ₽".replace(",", " "))
            self.hero_sub.setText("Факт — ваш счёт. План — целевые доли.")
            self.donut_fact.draw_shares(pairs, funds, bonds, "счёт")
            rows = actual["rows"]
        else:
            pairs, funds, bonds = plan_pairs, plan_funds, plan_bonds
            self.hero_value.setText("План")
            self.hero_sub.setText("Факт пуст, пока счёт не подключён.")
            self.donut_fact.draw_shares(0, 0, 0, "0", empty=True)
            rows = [
                ("Пара доллар", "Валютные пары", weights["usd"] * 100, usd),
                ("Пара юань", "Валютные пары", weights["cny"] * 100, cny),
                ("ОФЗ 26232", "Рублёвые облигации", weights["rub"] * 100, market["ofz"]),
                ("LQDT", "Денежный рынок", weights["lqdt"] * 100, market["lqdt"]),
                ("TMON", "Денежный рынок", weights["tmon"] * 100, market["tmon"]),
            ]
        gap = total - CREDIT_RATES[0][1]
        color = "#00A32A" if gap >= 0 else "#E31C23"
        self.hero_gap.setText(f"прогноз {total:.1f}%   ·   ключевая {CREDIT_RATES[0][1]:.0f}%   ·   {gap:+.1f} п.п.")
        self.hero_gap.setStyleSheet(f"color: {color}; font-weight: 700;")
        self.pairs_value.setText(f"{pairs:.0f}%")
        self.mm_value.setText(f"{funds:.0f}%")
        self.rub_value.setText(f"{bonds:.0f}%")
        self.pairs_hint.setText(f"доллар {usd:.1f}% · юань {cny:.1f}%")
        self.mm_hint.setText(f"LQDT {market['lqdt']:.1f}% · TMON {market['tmon']:.1f}%")
        self.rub_hint.setText(f"ОФЗ {market['ofz']:.1f}%")
        self._fill_positions(rows)
        self._fill_analytics(market, usd, cny, total, weights)
        if live:
            self.log("Данные обновлены")

    def _account_buckets(self):
        empty = {"total": 0, "pairs": 0, "funds": 0, "bonds": 0, "rows": []}
        if not self.client or not self.account_id:
            return empty
        try:
            payload = self.client.get_portfolio(self.account_id)
        except Exception as error:
            self.log(f"Портфель недоступен: {error}")
            return empty
        positions = payload.get("positions") or []
        buckets = empty
        for item in positions:
            ticker = (item.get("ticker") or "").upper()
            figi = item.get("figi") or ""
            kind = (item.get("instrumentType") or "").lower()
            value = abs(money(item.get("currentPrice")) * money(item.get("quantity")))
            if value <= 0:
                continue
            if ticker in MM_TICKERS or kind == "etf" and ticker in MM_TICKERS:
                group, key = "Денежный рынок", "funds"
            elif ticker in PAIR_TICKERS or figi in BOND_ISINS or ticker in BOND_ISINS or kind == "futures":
                group, key = "Валютные пары", "pairs"
            elif "bond" in kind or ticker.startswith("SU") or "ОФЗ" in (item.get("name") or ""):
                group, key = "Рублёвые облигации", "bonds"
            else:
                group, key = "Прочее", "bonds"
            buckets[key] += value
            buckets["total"] += value
            yield_pct = money(item.get("expectedYield"))
            buckets["rows"].append((item.get("name") or ticker or "Позиция", group, None, yield_pct))
            buckets["rows"][-1] = (buckets["rows"][-1][0], group, value, yield_pct)
        return buckets

    def _fill_positions(self, rows):
        values = [row[2] or 0 for row in rows]
        as_percent = bool(values) and max(values) <= 100 and abs(sum(values) - 100) < 5
        total = sum(values) or 1
        self.positions.setRowCount(len(rows))
        for index, (name, group, share, ytm) in enumerate(rows):
            percent = (share or 0) if as_percent else (share or 0) / total * 100
            self.positions.setItem(index, 0, QTableWidgetItem(str(name)))
            self.positions.setItem(index, 1, QTableWidgetItem(group))
            self.positions.setItem(index, 2, QTableWidgetItem(f"{percent:.0f}%"))
            self.positions.setItem(index, 3, QTableWidgetItem(f"{ytm:.1f}%"))
        self.positions.resizeRowsToContents()

    def _fill_analytics(self, market, usd, cny, total, weights):
        lines = [f"Прогноз книги {total:.1f}%. {market['source']}.", ""]
        for name, rate, note in CREDIT_RATES:
            lines.append(f"{name}: {rate:.2f}% · разрыв {total - rate:+.1f} п.п. · {note}")
        lines.append("")
        lines.append(
            "Доли: пары {:.0f}% + {:.0f}%, фонды {:.0f}% + {:.0f}%, ОФЗ {:.0f}%.".format(
                weights["usd"] * 100, weights["cny"] * 100, weights["lqdt"] * 100, weights["tmon"] * 100, weights["rub"] * 100
            )
        )
        lines.append(f"Пара доллар {usd:.1f}%, пара юань {cny:.1f}%.")
        self.analytics_text.setPlainText("\n".join(lines))

    def launch_strategy(self):
        if self.client is None and self.token_input.text().strip():
            self.connect_api()
        self.refresh_stats(False)
        usd, cny, mm = self.last_carries
        text = (
            f"Прогноз {self.forecast:.1f}% годовых.\n"
            f"Пары {self.pairs_value.text()}, фонды {self.mm_value.text()}, облигации {self.rub_value.text()}.\n\n"
            "Заявки не отправлены. Состав пересчитан. "
            "Покупка из подушки включается отдельно на вкладке «Стратегия»."
        )
        QMessageBox.information(self, "Стратегия", text)
        self.log("Стратегия пересчитана, заявки не отправлялись")

    def connect_api(self):
        token = self.token_input.text().strip()
        if not token or token == "YOUR_TOKEN_HERE":
            self.log("Вставьте токен")
            return
        try:
            self.client = TBankClient(token=token)
            accounts = self.client.get_accounts()
            self.account_id = accounts[0].get("id") if accounts else None
            name = accounts[0].get("name") if accounts else "без счетов"
            self.hero_sub.setText(f"Подключено · {name}")
            self.log(f"Счёт подключён: {name}")
            self.refresh_stats(False)
        except Exception as error:
            self.client = None
            self.account_id = None
            self.log(f"Нет подключения: {error}")

    def _set_auto(self, checked):
        self.auto_buy = checked
        self.log("Автозакуп " + ("включён" if checked else "выключен"))

    def evaluate_strategy(self):
        self.apply_params()
        if not hasattr(self, "last_carries"):
            self.refresh_stats(False)
        usd, cny, mm = self.last_carries
        actions = self.strategy.propose(
            usd_carry=usd, cny_carry=cny, cushion_yield=mm,
            usd_move_60d=0, cny_move_60d=0, usd_bond_own_move=0, cny_bond_own_move=0,
            hedge_gap_usd=0, hedge_gap_cny=0,
        )
        lines = []
        for action in actions:
            gate = "нужно подтверждение" if action["needs_confirm"] and not self.auto_buy else "без лишней покупки"
            if action["needs_confirm"] and self.auto_buy:
                gate = "галочка включена"
            lines.append(f"{action['title']} — {gate}\n{action['detail']}\n")
        self.strategy_status.setPlainText("\n".join(lines))

    def apply_params(self):
        try:
            self.strategy.params["cushion_yield"] = float(self.cushion_yield.text().replace(",", "."))
            self.strategy.params["carry_hurdle_spread"] = float(self.carry_spread.text().replace(",", "."))
            self.strategy.params["fx_rebalance_band"] = float(self.hedge_band.text().replace(",", "."))
            self.strategy.params["fx_extreme"] = float(self.fx_extreme.text().replace(",", "."))
            self.strategy.params["bond_dip_threshold"] = float(self.dip_thresh.text().replace(",", "."))
        except ValueError:
            self.log("Пороги должны быть числами")

    def log(self, message):
        self.log_text.append(message)
        logger.info(message)


def main():
    print("Инициализация приложения...")
    try:
        app = QApplication(sys.argv)
        app.setStyleSheet(STYLE)
        app.setFont(QFont("Segoe UI", 10))
        window = MainWindow()
        window.show()
        print("Окно показано. Запуск event loop...")
        sys.exit(app.exec())
    except Exception as error:
        print(f"Ошибка в main(): {error}")
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("=" * 50)
        print("КРИТИЧЕСКАЯ ОШИБКА ПРИ ЗАПУСКЕ")
        print(error)
        import traceback
        traceback.print_exc()
        print("=" * 50)
        input("\nНажмите Enter для выхода...")
        sys.exit(1)

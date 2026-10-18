"""
Barbell: RUB bonds and money market as a cushion, USD and CNY pairs as the carry.
Currency risk is not faded. Large FX moves only restore the hedge.
The cushion is spent on a matched pair when carry is rich, or when the bond
cheapens in its own currency.
"""
from typing import Dict, List


class CarryStrategy:
    def __init__(self, params: Dict = None):
        self.params = params or {}

    def net_carry(self, ytm: float, funding: float, price: float, margin: float = 10.0, cost: float = 0.5) -> float:
        """After-tax carry on rubles invested. YTM already includes pull-to-par. Rates in percent."""
        tax = 0.87
        numerator = tax * (ytm / 100) * (price / 100) + tax * (funding / 100) - cost / 100
        denominator = price / 100 + margin / 100
        return numerator / denominator * 100

    def weights(self, usd_weak: bool, cny_weak: bool) -> Dict[str, float]:
        """On a weak pair or a FX anomaly, cut that pair in half and move the money to the cushion."""
        weights = {"usd": 0.40, "cny": 0.20, "rub": 0.25, "lqdt": 0.10, "tmon": 0.05}
        if usd_weak:
            cut = weights["usd"] * 0.5
            weights["usd"] -= cut
            weights["rub"] += cut * 0.6
            weights["lqdt"] += cut * 0.4
        if cny_weak:
            cut = weights["cny"] * 0.5
            weights["cny"] -= cut
            weights["rub"] += cut * 0.6
            weights["lqdt"] += cut * 0.4
        return weights

    def propose(self, usd_carry: float, cny_carry: float, cushion_yield: float,
                usd_move_60d: float, cny_move_60d: float,
                usd_bond_own_move: float, cny_bond_own_move: float,
                hedge_gap_usd: float, hedge_gap_cny: float) -> List[Dict]:
        """
        Each action is a suggestion. needs_confirm is False only for hedge repair
        and for income that stays inside a sleeve. Spending the cushion always
        needs confirmation unless the user turned auto-buy on in the window.
        """
        spread = self.params.get("carry_hurdle_spread", 1.5)
        extreme = self.params.get("fx_extreme", 15.0)
        band = self.params.get("fx_rebalance_band", 8.0)
        dip = self.params.get("bond_dip_threshold", 3.0)
        actions = []

        best_name, best = ("USD", usd_carry) if usd_carry >= cny_carry else ("CNY", cny_carry)
        weak_name, weak = ("CNY", cny_carry) if best_name == "USD" else ("USD", usd_carry)

        if best >= cushion_yield + spread:
            actions.append({
                "title": f"Довнести в пару {best_name}",
                "detail": (
                    f"Чистый carry {best_name} {best:.1f}% против подушки {cushion_yield:.1f}%. "
                    "Покупать облигацию и столько же шорта, не голый курс. Брать из рублёвых облигаций, не из денежного пола."
                ),
                "needs_confirm": True,
            })
        if weak < cushion_yield:
            actions.append({
                "title": f"Сократить пару {weak_name}",
                "detail": (
                    f"Carry {weak_name} {weak:.1f}% ниже денежного рынка {cushion_yield:.1f}%. "
                    "Долю пары уменьшить вдвое, освободившееся направить в LQDT и короткую ОФЗ. Денежный пол не трогать."
                ),
                "needs_confirm": False,
            })

        for name, gap in (("USD", hedge_gap_usd), ("CNY", hedge_gap_cny)):
            if abs(gap) >= band:
                actions.append({
                    "title": f"Починить хедж {name}",
                    "detail": (
                        f"Шорт разошёлся с номиналом облигаций на {gap:+.1f}%. "
                        "Вернуть к одному к одному. Это убирает случайный валютный риск, а не добавляет новый."
                    ),
                    "needs_confirm": True,
                })

        for name, move in (("USD", usd_move_60d), ("CNY", cny_move_60d)):
            if abs(move) >= extreme:
                actions.append({
                    "title": f"Крупный ход {name}: не усреднять",
                    "detail": (
                        f"За 60 дней {name} {move:+.1f}%. На истории такие ходы были продолжением тренда, "
                        "покупка просадки и наращивание шорта против хода теряли деньги. Подушку не продавать ради курса."
                    ),
                    "needs_confirm": False,
                })

        for name, own in (("USD", usd_bond_own_move), ("CNY", cny_bond_own_move)):
            if own <= -dip:
                actions.append({
                    "title": f"Просадка тела облигации {name}",
                    "detail": (
                        f"Цена в валюте бумаги {own:.1f}% и это не объясняется курсом. "
                        "Можно докупить пару облигация+шорт из рублёвой подушки. Денежный пол не трогать."
                    ),
                    "needs_confirm": True,
                })
        if not actions:
            actions.append({
                "title": "Держать",
                "detail": "Ни carry, ни хедж, ни тело облигации не вышли за порог.",
                "needs_confirm": False,
            })
        return actions

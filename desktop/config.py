"""
Configuration and token management for T-Bank API.
User inserts their token from personal cabinet here or via .env
"""
import os
from dotenv import load_dotenv

load_dotenv()

# Токен песочницы Т-Инвестиций. Боевой токен сюда не класть.
TOKEN = os.getenv("TBANK_TOKEN", "")

# Токен выше выпущен для песочницы, не для боевого счёта.
USE_SANDBOX = True

# Reliable high-liquidity instruments only
RELIABLE_BONDS = {
    "RU000A10AXW4": {"name": "СИБУР Холдинг 001Р-03", "currency": "USD", "rating": "AAA", "coupon_freq": 12},
    # Add more AAA liquid bonds here as needed
}

RELIABLE_FUTURES = {
    "USDRUBF": {"name": "USD/RUB Perpetual", "lot": 1000, "currency": "USD"},
    "CNYRUBF": {"name": "CNY/RUB Perpetual", "lot": 1000, "currency": "CNY"},
    # EURRUBF can be added later if liquidity sufficient
}

# Strategy parameters
STRATEGY_PARAMS = {
    "usd_pair": 0.40,
    "cny_pair": 0.20,
    "rub_bonds": 0.25,
    "money_market": 0.15,
    "money_market_floor": 0.10,
    "carry_hurdle_spread": 1.5,
    "fx_rebalance_band": 8.0,
    "fx_extreme": 15.0,
    "bond_dip_threshold": 3.0,
    "cushion_yield": 12.0,
}

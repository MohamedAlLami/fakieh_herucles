"""Built-in material codes (a copy of the batch system's Materials.xml from 2026-11-10).

The live list comes from services.material_master, which follows Materials.xml on the batch PC.
This built-in copy is the fallback when that list is not available, and it still gives a name
to codes that old records use.
"""

from __future__ import annotations

from typing import Optional

MATERIAL_CODES = [
    {"code": "None", "name": "None"},
    {"code": "0", "name": "Empty"},
    {"code": "1", "name": "Not Used"},
    {"code": "3", "name": "CYROMAZINE 1%"},
    {"code": "4", "name": "REHYDRAPRO RM"},
    {"code": "5", "name": "COXISTAC"},
    {"code": "6", "name": "NOVELA ECL"},
    {"code": "7", "name": "ENSPIRA PLUS"},
    {"code": "8", "name": "SENITHETIC LYSIN"},
    {"code": "9", "name": "VINCON"},
    {"code": "10", "name": "LIGNOBOND DD"},
    {"code": "12", "name": "Methionine"},
    {"code": "13", "name": "CIBENZA"},
    {"code": "14", "name": "OXISTAT"},
    {"code": "15", "name": "OXY-NIL RX Dry"},
    {"code": "16", "name": "NEOMYCINE"},
    {"code": "17", "name": "COXIRIL"},
    {"code": "18", "name": "ENDOX DRY"},
    {"code": "19", "name": "HADOX DRY"},
    {"code": "20", "name": "OXYTETRACYCLINE"},
    {"code": "21", "name": "Provi Oxi Stop"},
    {"code": "22", "name": "FLUBENOL"},
    {"code": "23", "name": "CAROPHYLL RED"},
    {"code": "24", "name": "LEADER RED"},
    {"code": "25", "name": "A-SORB"},
    {"code": "26", "name": "Choline Chloride 60%"},
    {"code": "27", "name": "MONTOBAN"},
    {"code": "28", "name": "FORMAXOL-F, KEMIN"},
    {"code": "29", "name": "KEMSAVOR DRY"},
    {"code": "30", "name": "LYSOFORTE DRY"},
    {"code": "31", "name": "Broiler Mineral Mix"},
    {"code": "32", "name": "BRD MIN"},
    {"code": "33", "name": "TermiN-8"},
    {"code": "34", "name": "LAY MINERAL MIX"},
    {"code": "35", "name": "SOUDIOM Bicarbon"},
    {"code": "36", "name": "CYCOSTAT *66 G"},
    {"code": "37", "name": "SALMO NIL LIQUID"},
    {"code": "38", "name": "VATEC 15% CC"},
    {"code": "39", "name": "VIRGENIAMYCIN"},
    {"code": "40", "name": "Lay Min. Old"},
    {"code": "41", "name": "FYSAL LIQ(ANTISA"},
    {"code": "42", "name": "METHIONINE LIQUE"},
    {"code": "43", "name": "Moldonin Liquid"},
    {"code": "44", "name": "Phytase 10000 1000FTU (100g)"},
    {"code": "45", "name": "NOVIBAC F Liquid"},
    {"code": "46", "name": "BENTONELT"},
    {"code": "47", "name": "SALGARD LEQUID"},
    {"code": "48", "name": "MAXUS 100"},
    {"code": "49", "name": "Pelcin"},
    {"code": "50", "name": "BROILER VIT MIX"},
    {"code": "51", "name": "LAYER VIT MIX"},
    {"code": "52", "name": "AMNIL"},
    {"code": "53", "name": "SelenoSource AF3"},
    {"code": "54", "name": "FOSPAC PLUS T PR"},
    {"code": "55", "name": "BERGAZYM"},
    {"code": "56", "name": "VITAMIN C"},
    {"code": "57", "name": "BREEDER VIT 2"},
    {"code": "58", "name": "SELISSEO 0.1%SE"},
    {"code": "59", "name": "Breeder Vit"},
    {"code": "60", "name": "L Threonine"},
    {"code": "62", "name": "Econase XT25(100g)"},
    {"code": "69", "name": "Broiler Starter PX"},
    {"code": "70", "name": "Broiler Grower PX"},
    {"code": "71", "name": "Broiler Finisher PX"},
    {"code": "72", "name": "L-VALINE 98%"},
    {"code": "73", "name": "L Isoleucine"},
    {"code": "74", "name": "Rovabio Advance"},
    {"code": "75", "name": "ROVABIO PhyPlus"},
    {"code": "77", "name": "KENZYME PRO"},
    {"code": "78", "name": "SAL CURB"},
    {"code": "79", "name": "Sangrovit"},
    {"code": "80", "name": "Celatom AFA"},
    {"code": "81", "name": "Ronozyme Pro Act"},
    {"code": "82", "name": "AVIZYME"},
    {"code": "83", "name": "PHYZYME"},
    {"code": "84", "name": "LYSOFORTE"},
    {"code": "85", "name": "NUTRILAC"},
    {"code": "86", "name": "LINCO MIX 44"},
    {"code": "87", "name": "limestone 20kg"},
    {"code": "88", "name": "BINDER"},
    {"code": "89", "name": "RONOZYМE"},
    {"code": "90", "name": "Hemicell-MP"},
    {"code": "91", "name": "Sacox (500g)"},
    {"code": "92", "name": "Micro Crube Liq."},
    {"code": "93", "name": "LIMESTONE FLISH"},
    {"code": "94", "name": "LIMESTONEIZE"},
    {"code": "95", "name": "SALKIL"},
    {"code": "96", "name": "KAMERA LIQUID"},
    {"code": "97", "name": "MICROVIT(E)TPM50"},
    {"code": "98", "name": "NOVIMOLD LIQUID"},
    {"code": "99", "name": "MIX(20%SAL+80%WA"},
    {"code": "100", "name": "Maize"},
    {"code": "101", "name": "MAIZE-B"},
    {"code": "102", "name": "MAIZE-C"},
    {"code": "104", "name": "BARLY"},
    {"code": "105", "name": "SOYA"},
    {"code": "106", "name": "SOYA-B"},
    {"code": "109", "name": "SOYA YUONBA"},
    {"code": "110", "name": "REWORK 22110"},
    {"code": "111", "name": "HY-Bond"},
    {"code": "112", "name": "Wheat- Bran"},
    {"code": "113", "name": "Limestone"},
    {"code": "114", "name": "WHEAT FLOUR"},
    {"code": "115", "name": "TECHNOMOS"},
    {"code": "116", "name": "D.D.G.S"},
    {"code": "118", "name": "RHODIMET AT 88"},
    {"code": "120", "name": "Availa Zn 120"},
    {"code": "121", "name": "FORMALIN LIQUID"},
    {"code": "122", "name": "FORMI NDF"},
    {"code": "123", "name": "L&amp;STONE COARSE"},
    {"code": "124", "name": "SOLIS"},
    {"code": "125", "name": "Integral"},
    {"code": "126", "name": "LEVUCELL SBO"},
    {"code": "127", "name": "SILO HEALTH 110"},
    {"code": "128", "name": "Quantum Blue 5G"},
    {"code": "129", "name": "AXTRAPHY"},
    {"code": "130", "name": "Optiphos Plus 10"},
    {"code": "131", "name": "Cabanin CSD"},
    {"code": "132", "name": "Salmocid - F"},
    {"code": "133", "name": "MiaBond360"},
    {"code": "134", "name": "Formycine Liq."},
    {"code": "135", "name": "AXTRA XB201 TРТ"},
    {"code": "136", "name": "ENVIVA PRO201 BA"},
    {"code": "137", "name": "Galli PRO Fit"},
    {"code": "138", "name": "Xcelsio"},
    {"code": "139", "name": "INTEGRAL-LR"},
    {"code": "140", "name": "BIOSTRONG 510"},
    {"code": "141", "name": "BIOSTRONG-FL"},
    {"code": "142", "name": "BETAIN HCL"},
    {"code": "143", "name": "ARBOCEL-RC"},
    {"code": "144", "name": "AVAILA ZMC"},
    {"code": "146", "name": "CELMANAX DRY"},
    {"code": "147", "name": "Panbonis 20"},
    {"code": "148", "name": "Omega pro Extra"},
    {"code": "149", "name": "HERBIN"},
    {"code": "150", "name": "AXXESS XY"},
    {"code": "151", "name": "Sodium Sulphate"},
    {"code": "152", "name": "Lysine Sulfate"},
    {"code": "153", "name": "MDCP"},
    {"code": "156", "name": "PHYTOCEЕ"},
    {"code": "158", "name": "MyCofix"},
    {"code": "159", "name": "Allzyme Vegpro"},
    {"code": "176", "name": "Rovabio P10"},
    {"code": "179", "name": "ACTIVO"},
    {"code": "199", "name": "MIXED MEALE"},
    {"code": "202", "name": "Salt"},
    {"code": "204", "name": "Monocalcium Phos"},
    {"code": "205", "name": "DICAL PHOS S"},
    {"code": "210", "name": "Soya Oil"},
    {"code": "300", "name": "Water"},
    {"code": "999", "name": "Out Of Service"},
    {"code": "5000", "name": "PRODUCT1"},
    {"code": "11203", "name": "Flush system"},
    {"code": "12355", "name": "BR-GR"},
    {"code": "12395", "name": "BR-FN"},
    {"code": "12542", "name": "LY-PR-003"},
    {"code": "12550", "name": "LY-PR-01"},
    {"code": "12560", "name": "LY-PR-02"},
    {"code": "12570", "name": "LY-PR-03"},
    {"code": "13335", "name": "BR-ST"},
    {"code": "13402", "name": "LY-ST"},
    {"code": "13412", "name": "LY-GR"},
    {"code": "13422", "name": "LA-DV"},
    {"code": "13432", "name": "LY-PL"},
    {"code": "22355", "name": "BR-GR-Bags"},
    {"code": "22357", "name": "CM-BR-GRF"},
    {"code": "22395", "name": "BR-FN-Bags"},
    {"code": "22397", "name": "CM-BR-FNF"},
    {"code": "23315", "name": "CM-BR-STF"},
    {"code": "23335", "name": "BR-ST-Bags"},
    {"code": "23357", "name": "CM-BR-GRF1"},
]

# Codes used before the 2026-11 master list; kept only so old records still resolve a name.
LEGACY_MATERIAL_CODES = [
    {"code": "002", "name": "Soya"},
    {"code": "035", "name": "Sodium Bicarbonate"},
    {"code": "012", "name": "DL Methionine"},
    {"code": "073", "name": "L Isoleucine"},
    {"code": "060", "name": "L Threonine"},
    {"code": "072", "name": "L Valine"},
]

DISALLOWED_MATERIAL_CODES = frozenset({"None", "0", "000", "1", "999", ""})


def _master():
    try:
        from services import material_master
        return material_master
    except Exception:
        return None


def resolve_material_name(code: str) -> Optional[str]:
    code = str(code).strip()
    master = _master()
    if master is not None:
        try:
            name = master.name_of(code)
            if name:
                return name
        except Exception:
            pass
    for item in MATERIAL_CODES + LEGACY_MATERIAL_CODES:
        if item["code"] == code:
            return item["name"]
    return None


def is_valid_material_code(code: str) -> bool:
    code = str(code).strip()
    if not code or code in DISALLOWED_MATERIAL_CODES:
        return False
    master = _master()
    if master is not None:
        try:
            return master.is_active(code)
        except Exception:
            pass
    return any(item["code"] == code for item in MATERIAL_CODES)

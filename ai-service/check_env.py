import sys
import os

result = []

try:
    from packaging.version import Version
    result.append("packaging: AVAILABLE")
except Exception as e:
    result.append(f"packaging: NOT AVAILABLE ({e})")

try:
    from IndicTransToolkit.processor import IndicProcessor
    import inspect
    sig = inspect.signature(IndicProcessor.__init__)
    result.append(f"IndicProcessor.__init__ signature: {sig}")
    
    # Check source code if available
    try:
        src = inspect.getsource(IndicProcessor)
        result.append("IndicProcessor source retrieved successfully")
        if "tokenizer" in src or "model" in src:
            result.append("IndicProcessor source mentions tokenizer/model")
        else:
            result.append("IndicProcessor source does NOT mention tokenizer/model")
    except Exception as e:
        result.append(f"Could not get IndicProcessor source code: {e}")
except Exception as e:
    result.append(f"IndicProcessor: COULD NOT IMPORT ({e})")

# Write to file
with open("check_env_result.txt", "w") as f:
    f.write("\n".join(result))
print("Done checking.")

import re, shutil

FILE = r'C:\Users\darkd\OneDrive\Desktop\madina-medicine\app\page.tsx'
shutil.copy(FILE + '.bak', FILE)

with open(FILE, 'r', encoding='utf-8') as f:
    content = f.read()

FONT_SIZES = {'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'}

def get_utility_type(cls):
    c = cls
    hover = ''
    if c.startswith('dark:'):
        c = c[5:]
    if c.startswith('hover:'):
        c = c[6:]
        hover = 'hover:'
    
    for util in ['bg', 'border']:
        if c.startswith(util + '-'):
            return hover + util
    
    if c.startswith('text-'):
        value = c[5:]
        # Strip opacity modifiers like /50
        base_value = value.split('/')[0]
        if base_value in FONT_SIZES:
            return None  # font-size, not a color utility - don't pair
        return hover + 'text'
    
    return None

def process_class_tokens(tokens):
    dark_info = {}
    light_by_util = {}
    for i, token in enumerate(tokens):
        ut = get_utility_type(token)
        if ut is None:
            continue
        if token.startswith('dark:'):
            dark_info[i] = (ut, token[5:])
        else:
            light_by_util.setdefault(ut, []).append((i, token))
    if not dark_info:
        return None
    used = set()
    pairs = []
    for di, (dut, dval) in dark_info.items():
        if dut in light_by_util and light_by_util[dut]:
            li, lval = light_by_util[dut].pop(0)
            used.add(di)
            used.add(li)
            pairs.append((lval, dval))
    remaining = [t for i, t in enumerate(tokens) if i not in used]
    if not pairs:
        return None
    dark_str = ' '.join(p[1] for p in pairs)
    light_str = ' '.join(p[0] for p in pairs)
    remaining_str = ' '.join(remaining)
    if remaining_str:
        return f"isDarkMode ? '{dark_str} {remaining_str}' : '{light_str} {remaining_str}'"
    else:
        return f"isDarkMode ? '{dark_str}' : '{light_str}'"

def fix_line(line):
    if 'dark:' not in line:
        return line
    if 'dark: {}' in line:
        return line

    def replace_static_cn(m):
        cls_content = m.group(1)
        if 'dark:' not in cls_content:
            return m.group(0)
        tokens = cls_content.split()
        result = process_class_tokens(tokens)
        if result:
            return f'className={{{result}}}'
        return m.group(0)
    line = re.sub(r'className="([^"]*)"', replace_static_cn, line)

    def replace_single_quoted(m):
        cls_content = m.group(1)
        if 'dark:' not in cls_content:
            return m.group(0)
        tokens = cls_content.split()
        result = process_class_tokens(tokens)
        if result:
            return f'({result})'
        return m.group(0)
    line = re.sub(r"'([^'\n]*dark:[^'\n]*)'", replace_single_quoted, line)

    return line

lines = content.split('\n')
new_lines = []
for i, line in enumerate(lines):
    line_num = i + 1
    if line_num == 373:
        new_lines.append(line)
        continue
    new_lines.append(fix_line(line))

content = '\n'.join(new_lines)

with open(FILE, 'w', encoding='utf-8') as f:
    f.write(content)

with open(FILE, 'r', encoding='utf-8') as f:
    result = f.read()
count = len(re.findall(r'dark:', result)) - 1
print(f"Remaining dark: classes: {count}")
if count > 0:
    for i, line in enumerate(result.split('\n')):
        if 'dark:' in line and 'dark: {}' not in line:
            print(f"  Line {i+1}: {line.strip()[:150]}")

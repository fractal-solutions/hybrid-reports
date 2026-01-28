import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

// Helper to safely get nested properties
function getNestedValue(obj, path) {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

// Helper to encode image to base64
function encodeImageToBase64(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            console.warn(`Warning: Image file not found at ${filePath}`);
            return '';
        }
        const img = fs.readFileSync(filePath);
        const ext = path.extname(filePath).substring(1).toLowerCase();
        // Simple mapping, can be expanded
        const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`; 
        return `data:${mimeType};base64,${img.toString('base64')}`;
    } catch (e) {
        console.warn(`Error reading image ${filePath}:`, e);
        return '';
    }
}

async function renderReport(jsonPath, outputPdfPath) {
    console.log(`Reading data from ${jsonPath}...`);
    const rawData = fs.readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(rawData);

    // Paths
    const templatePath = path.join(import.meta.dir, 'templates', 'report.html');
    const stylePath = path.join(import.meta.dir, 'templates', 'report_style.css');
    const logoPath = path.join(import.meta.dir, 'templates', 'eldama-logo.png');

    console.log('Reading templates...');
    let html = fs.readFileSync(templatePath, 'utf-8');
    const css = fs.readFileSync(stylePath, 'utf-8');
    const logoBase64 = encodeImageToBase64(logoPath);

    // 1. Inject CSS and Logo
    html = html.replace('{{style}}', css);
    html = html.replace('{{logo_path}}', logoBase64);

    // 2. Pre-process Lists (to generate HTML for <ul>)
    // Recommendations
    if (data.recommendations && Array.isArray(data.recommendations)) {
        const listHtml = data.recommendations.map(item => `<li>${item}</li>`).join('\n');
        data.recommendations_html = listHtml;
    } else {
        data.recommendations_html = '<li>No recommendations provided.</li>';
    }

    // Windows 10 Users
    if (data.patch_management && data.patch_management.windows_10_users_list && Array.isArray(data.patch_management.windows_10_users_list)) {
        const listHtml = data.patch_management.windows_10_users_list.map(user => `<li>${user}</li>`).join('\n');
        data.patch_management.windows_10_users_list_html = listHtml;
    } else {
        if (!data.patch_management) data.patch_management = {};
        data.patch_management.windows_10_users_list_html = '<li>None listed.</li>';
    }

    // 3. Process Images (Find keys ending in _path or strictly known keys)
    // We can recursively walk the object or just check specific keys known from schema.
    // For robustness, let's walk the known schema paths that are images.
    const imageKeys = [
        'scores.services_delivered_chart_path',
        'device_health.chart_path',
        'device_health.metrics.disk_space.chart_path',
        'antivirus.chart_path',
        'patch_management.chart_path'
    ];

    for (const keyPath of imageKeys) {
        const imgPath = getNestedValue(data, keyPath);
        if (imgPath) {
            // Resolve path relative to CWD or JSON file location
            // Assuming agent outputs relative paths like 'assets/foo.png'
            const absolutePath = path.resolve(process.cwd(), imgPath);
            console.log(`Encoding image: ${imgPath} -> ${absolutePath}`);
            const base64 = encodeImageToBase64(absolutePath);
            
            // Now replace the Value in the data object so the template replacer picks it up?
            // No, the template has {{scores.services_delivered_chart_path}}.
            // We need to update the data object's value to the base64 string.
            
            // Helper to set nested value
            const keys = keyPath.split('.');
            let current = data;
            for (let i = 0; i < keys.length - 1; i++) {
                if (!current[keys[i]]) current[keys[i]] = {};
                current = current[keys[i]];
            }
            current[keys[keys.length - 1]] = base64;
        }
    }

    // 4. Replace Placeholders in HTML
    // Regex to find {{key.subkey}}
    html = html.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (match, keyPath) => {
        // Special handled keys (lists) are now top-level or nested properly in data
        // Check if data has it
        const val = getNestedValue(data, keyPath);
        return val !== undefined ? val : match; // Leave unmatched if undefined
    });

    // 5. Generate PDF
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: "new" // or true
    });
    const page = await browser.newPage();
    
    console.log('Setting content...');
    // We use setContent. Base64 images are heavy, but usually fine for local rendering.
    await page.setContent(html, { waitUntil: 'networkidle0' });

    console.log(`Writing PDF to ${outputPdfPath}...`);
    await page.pdf({
        path: outputPdfPath,
        format: 'A4',
        printBackground: true,
        margin: {
            top: '20mm',
            bottom: '20mm',
            left: '20mm',
            right: '20mm'
        }
    });

    await browser.close();
    console.log('Done.');
}

// CLI Entry point
const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('Usage: bun src/renderer.js <input.json> <output.pdf>');
    process.exit(1);
}

renderReport(args[0], args[1]).catch(err => {
    console.error('Error rendering report:', err);
    process.exit(1);
});

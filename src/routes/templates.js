import { Router } from 'express';
import { getTemplates, saveTemplates, validateTemplates, renderTemplate, parseTemplate, PRESETS } from '../services/template.js';
import { logger } from '../services/logger.js';

export const templateRouter = Router();

// Get templates
templateRouter.get('/', (req, res) => {
  const tmpl = getTemplates();
  res.json(tmpl || {});
});

// Update templates
templateRouter.put('/', (req, res) => {
  const errors = validateTemplates(req.body);
  if (errors.length > 0) return res.status(400).json({ error: '模板校验失败', details: errors });
  saveTemplates(req.body);
  res.json({ success: true });
});

// Preview template
templateRouter.post('/preview', (req, res) => {
  const { template, vars } = req.body;
  if (!template) return res.status(400).json({ error: '模板不能为空' });
  const result = renderTemplate(template, vars || {});
  res.json({ result });
});

// Restore defaults
templateRouter.post('/reset', (req, res) => {
  const { preset } = req.body;
  const target = (preset && PRESETS[preset]) ? PRESETS[preset] : PRESETS['标准'];
  saveTemplates({ ...target });
  res.json({ success: true, templates: target });
});

// Parse filename against template
templateRouter.post('/parse', (req, res) => {
  const { template, input } = req.body;
  if (!template || !input) return res.status(400).json({ error: '参数不能为空' });
  const result = parseTemplate(template, input);
  res.json(result);
});

// Get presets
templateRouter.get('/presets', (req, res) => {
  res.json(PRESETS);
});

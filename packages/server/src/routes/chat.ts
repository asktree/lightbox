import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import type { LightManager } from '../lib/light-manager.js';
import type { MessageParam, Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';

const SYSTEM_PROMPT = `You are a helpful assistant that controls smart lights. You can:
- List available lights and their current states
- Turn lights on/off
- Change brightness (0-100)
- Change color using hue (0-360) and saturation (0-100)
- Change color temperature in Kelvin (2700-6500)
- Control groups of lights
- List saved palettes (color animation tracks)

Be concise in your responses. When the user asks to change lights, do it and confirm briefly.`;

const tools: Tool[] = [
  {
    name: 'list_lights',
    description: 'Get a list of all available lights with their current state',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'set_light',
    description: 'Control a single light. Can turn on/off, set brightness, color, or temperature.',
    input_schema: {
      type: 'object' as const,
      properties: {
        light_id: {
          type: 'string',
          description: 'The ID of the light to control',
        },
        on: {
          type: 'boolean',
          description: 'Turn the light on (true) or off (false)',
        },
        brightness: {
          type: 'number',
          description: 'Brightness level from 0 to 100',
        },
        color: {
          type: 'object',
          properties: {
            h: { type: 'number', description: 'Hue from 0 to 360' },
            s: { type: 'number', description: 'Saturation from 0 to 100' },
          },
          description: 'Color as hue and saturation',
        },
        temperature: {
          type: 'number',
          description: 'Color temperature in Kelvin (2700-6500)',
        },
      },
      required: ['light_id'],
    },
  },
  {
    name: 'set_all_lights',
    description: 'Control all reachable lights at once',
    input_schema: {
      type: 'object' as const,
      properties: {
        on: { type: 'boolean' },
        brightness: { type: 'number' },
        color: {
          type: 'object',
          properties: {
            h: { type: 'number' },
            s: { type: 'number' },
          },
        },
        temperature: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'list_palettes',
    description: 'Get a list of saved color palettes (animation tracks on the color wheel)',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

export function createChatRouter(lightManager: LightManager): Router {
  const router = Router();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('Chat: ANTHROPIC_API_KEY not set, chat endpoint will be disabled');
  }

  const client = apiKey ? new Anthropic({ apiKey }) : null;

  // Execute a tool call
  async function executeTool(name: string, input: Record<string, any>): Promise<string> {
    try {
      switch (name) {
        case 'list_lights': {
          const lights = lightManager.getAllLights();
          return JSON.stringify(
            lights.map((l) => ({
              id: l.id,
              name: l.name,
              brand: l.brand,
              on: l.state.on,
              brightness: l.state.brightness,
              color: l.state.color,
              temperature: l.state.temperature,
              reachable: l.reachable,
            })),
            null,
            2
          );
        }

        case 'set_light': {
          const { light_id, on, brightness, color, temperature } = input;
          const state: Record<string, any> = {};
          if (on !== undefined) state.on = on;
          if (brightness !== undefined) state.brightness = brightness;
          if (color !== undefined) state.color = color;
          if (temperature !== undefined) state.temperature = temperature;

          await lightManager.setLightState(light_id, state);
          const light = lightManager.getLight(light_id);
          return `Set ${light?.name ?? light_id}: ${JSON.stringify(state)}`;
        }

        case 'set_all_lights': {
          const { on, brightness, color, temperature } = input;
          const state: Record<string, any> = {};
          if (on !== undefined) state.on = on;
          if (brightness !== undefined) state.brightness = brightness;
          if (color !== undefined) state.color = color;
          if (temperature !== undefined) state.temperature = temperature;

          const lights = lightManager.getAllLights().filter((l) => l.reachable);
          await Promise.all(lights.map((l) => lightManager.setLightState(l.id, state)));
          return `Set ${lights.length} lights: ${JSON.stringify(state)}`;
        }

        case 'list_palettes': {
          const palettes = lightManager.getPalettes();
          return JSON.stringify(
            palettes.map((p) => ({
              id: p.id,
              name: p.name,
              nodeCount: p.nodes.length,
              tension: p.tension,
              secondsPerNode: p.secondsPerNode,
            })),
            null,
            2
          );
        }

        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  router.post('/', async (req, res) => {
    if (!client) {
      res.status(503).json({ error: 'Chat not configured (missing ANTHROPIC_API_KEY)' });
      return;
    }

    const { messages } = req.body as { messages: MessageParam[] };

    try {
      let response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      // Handle tool use loop
      while (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
        const toolResults: ToolResultBlockParam[] = [];

        for (const block of toolUseBlocks) {
          if (block.type === 'tool_use') {
            const result = await executeTool(block.name, block.input as Record<string, any>);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result,
            });
          }
        }

        // Continue conversation with tool results
        response = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools,
          messages: [
            ...messages,
            { role: 'assistant', content: response.content },
            { role: 'user', content: toolResults },
          ],
        });
      }

      // Extract text response
      const textContent = response.content.find((b) => b.type === 'text');
      const text = textContent?.type === 'text' ? textContent.text : '';

      res.json({ response: text });
    } catch (err: any) {
      console.error('Chat error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

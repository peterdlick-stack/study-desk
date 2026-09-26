// Only changes this process. Does not modify system environment or the original app.
process.env.STUDY_DESK_DEMO = '1';
process.env.STUDY_DESK_ENABLE_AI = '0';
await import('../server.mjs');

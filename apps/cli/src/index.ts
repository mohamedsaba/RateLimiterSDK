#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import { table } from 'table';

const program = new Command();
const API_URL = process.env.RL_API_URL || 'http://localhost:3000/api';
const ADMIN_SECRET = process.env.RL_ADMIN_SECRET || 'super_secret_admin_key';

program
  .name('rl-admin')
  .description('Distributed Rate Limiter Management CLI')
  .version('0.0.1');

const tenant = program.command('tenant').description('Manage tenants');

tenant
  .command('list')
  .description('List all tenants')
  .action(async () => {
    try {
      const response = await axios.get(`${API_URL}/tenants`, {
        headers: { 'x-admin-secret': ADMIN_SECRET }
      });
      
      const data = [
        [chalk.bold('ID'), chalk.bold('Name'), chalk.bold('API Key'), chalk.bold('Created At')],
        ...response.data.map((t: any) => [t.id, t.name, t.apiKey, t.createdAt])
      ];
      
      console.log(table(data));
    } catch (error: any) {
      console.error(chalk.red('Error listing tenants:'), error.response?.data?.message || error.message);
    }
  });

tenant
  .command('create <name>')
  .description('Create a new tenant')
  .action(async (name) => {
    try {
      const response = await axios.post(`${API_URL}/tenants`, { name }, {
        headers: { 'x-admin-secret': ADMIN_SECRET }
      });
      
      console.log(chalk.green('Tenant created successfully:'));
      console.log(JSON.stringify(response.data, null, 2));
    } catch (error: any) {
      console.error(chalk.red('Error creating tenant:'), error.response?.data?.message || error.message);
    }
  });

program.parse();

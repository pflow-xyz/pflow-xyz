# Petri Net Examples

This directory contains example Petri net models in JSON-LD format.

## Examples

### Coffee Shop (Colored Petri Net)
**File:** `z4EBG9jDsuUdvVN4bUXRHxoDG3p274FfhcJd8BiruRcE1jLCHi8.jsonld`

A colored Petri net demonstrating support for multiple token types. This example models a simple coffee shop workflow with three token colors:

- **Red tokens** (customers) - representing customers waiting for coffee
- **Brown tokens** (coffee beans) - representing coffee supplies  
- **Blue tokens** (cups) - representing empty cups

#### Model Overview

The workflow includes:
1. **Customer Arrives** - adds customers to the waiting queue
2. **Brew Coffee** - requires 1 customer, 1 coffee bean, and 1 cup to produce served coffee
3. **Customer Leaves** - customer departs with coffee
4. **Restock Beans** - adds 3 coffee beans to inventory
5. **Restock Cups** - adds 3 cups to inventory

#### Colored Petri Net Features

This example demonstrates:
- **Multiple token types**: Defined in the `token` array with three URIs
- **Multi-dimensional weights**: Each arc has a 3-element weight array (e.g., `[1, 0, 0]` for red tokens only)
- **Multi-dimensional markings**: Places have 3-element arrays for `initial` and `capacity`
- **Token type separation**: Each token type operates independently along its designated arcs

#### Loading the Example

You can load this example in the viewer:
- Via CID: `http://localhost:8080/?o=z4EBG9jDsuUdvVN4bUXRHxoDG3p274FfhcJd8BiruRcE1jLCHi8`
- By embedding the JSON-LD in an HTML page with `<petri-view>` component

### Other Examples

The other example files demonstrate various Petri net patterns and can be loaded similarly using their CID filenames.

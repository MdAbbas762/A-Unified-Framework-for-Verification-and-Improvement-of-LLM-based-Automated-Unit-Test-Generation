# A Unified Framework for Verification & Improvement of LLM-Based Automated Unit Test Generation  

We have selected **automated unit test generation using Large Language Models (LLMs)** as our Final Year Project. This repository will serve as the **central record** for everything we produce as a team of **three members** including research artifacts, documentation, requirements, design, implementation, evaluation, and final reporting.  

Our project aims to understand the current limitations of LLM-generated unit tests and to design a **unified framework** that verifies, repairs, and strengthens these tests so they become more practical and dependable for real developers.  

---  

# 📌 Project Overview  

Unit tests are a critical part of software quality, yet they require substantial manual effort to write and maintain. Although LLMs can now generate test cases automatically, the produced tests often contain missing mocks, weak assertions, shallow coverage, or poor fault detection ability.  

Our project investigates these weaknesses in depth and aims to design a system that can **evaluate and improve** LLM-generated tests through a structured verification pipeline.This repository will document every stage of this journey, from literature study to requirement analysis and later development.  

---  

# 🕰️ Background  

Traditional automated test generation tools (e.g., EvoSuite, Randoop) rely on search-based and model-based strategies. They improve coverage but frequently produce brittle or assertion-poor tests. Moreover, Recent LLMs like GPT-4 have improved readability and logical structure, but **their tests still fail in real scenarios** due to:  

- Missing or incorrect mocks  
- Weak or trivial assertions  
- Low mutation scores  
- Poor repair success rates  
- Redundant or bloated test logic  

These issues show that LLMs alone are not enough. A structured verification and improvement process is needed to make their output reliably executable. This project is based on that need.  

---  

# ⚠️ Problem  

Based on our research, the core problems are:  

- LLM-generated tests often **fail to run** due to missing mocks/stubs.  
- Assertions are frequently **too shallow**, failing to capture real behavior.  
- Mutation testing reveals **weak fault detection** in many generated tests.  
- Current repair loops fail in most cases; fixes are not systematic.  
- Developers do not have a unified system that checks, repairs, and strengthens LLM-generated tests.  
- Existing tools each solve *only one* weakness, no single framework handles all of them together.  

These weaknesses motivate the need for a more unified, reliable, and developer-friendly approach.  

---  

# 💡 Solution Concept  

Our goal is to design a **unified framework** that improves the quality of LLM-generated unit tests. Based on our research and study, the framework will focus on the following core ideas:  

### 🔹 1. Detecting and Mocking External Dependencies  
Automatically identify API calls, file accesses, database operations, and generate proper mocks to prevent test failures.

### 🔹 2. A Multi-Step Repair Process  
Diagnose why tests fail and guide the LLM through systematic repair steps instead of one-shot fixes.  

### 🔹 3. Strengthening Assertions  
Detect trivial assertions and replace them with meaningful, semantics-based checks that better reflect intended behavior.  

### 🔹 4. Using Mutation Signals to Improve Test Strength  
Incorporate mutation testing feedback (e.g., StrykerJS) to gauge how well tests detect faults and guide improvements.  

### 🔹 5. Developer-Centric Interface  
Provide a simple way for developers to inspect generated tests, view validation results, and trigger improvements.  

This system is *not yet implemented*, but all design choices will be shaped by our research findings and requirement analysis.  

---  

# 📂 Project Progress   

## ✅ Completed  

### **1. Proposal Development & Defense**  
- Topic selection  
- Problem analysis  
- Project justification  
- Initial concept and motivation  
- Proposal document and presentation  

### **2. Chapter 1 – Introduction**  
We have completed:  
- Background  
- Problem statement  
- Scope  
- Motivation  
- High-level solution outline  
  
### **3. Chapter 2 – Background Study**  
In this phase we worked on **Systematic Literature Review**. Our SLR includes:  
- Review of 48 primary studies  
- Extraction of detailed technical data (inputs, outputs, tools, algorithms, validation methods)  
- A full **technical table of all papers**  
- Categorized sub-tables organized by techniques  
- Summary reports and analysis  
- All data stored and documented in this repository  

The SLR provides the foundation for our system requirements and design.  

### **4. Chapter 3 – Requirements Specification & Analysis**  
We (team of 3) are currently working on:  
- Software Requirements Specification (SRS)  
- Use case diagrams and descriptions  
- Functional and non-functional requirements  
- Domain model  
- Requirement tables  
- System constraints and assumptions  

### **5. Chapter 4 – Proposed Solution**  
- Software architecture  
- Data modeling  
  - Relational databases  
  - NoSQL databases  
- Workflow diagram for verification and improvement pipeline  
- Third-party dependencies (LLMs, mutation testing tools, mocking libraries)  

### **6. Chapter 5 – Software Development**  

### 🔹 Phase I – Dependency Detector & Mock Preparation Module  

As part of the initial development milestone, the foundational backend analysis pipeline has been implemented.  
This module was designed and developed by **Muhammad Abbas** and establishes the framework’s capability to interpret source code and prepare structured mocking requirements for unit testing environments.  

---
**Following are the key features:**  

#### 📂 Input Handling & Validation  

- Accepts JavaScript source files or directories as input  
- Validates provided paths before processing  
- Filters unsupported or invalid file types  
- Provides structured feedback for incorrect or empty inputs  

---

#### 🧠 Source Code Parsing  

- Converts JavaScript source code into an Abstract Syntax Tree (AST)  
- Enables structured representation of program logic  
- Detects syntax-level errors before analysis begins  

---

#### 🔍 Function Extraction & Classification  

- Detects functions defined within source files  
- Identifies exported functions as primary testing targets  
- Differentiates internal helper functions  
- Extracts key metadata 

---

#### 🔗 Dependency Identification  

- Detects imported modules inside source files  
- Maps imported identifiers to their corresponding modules  
- Determines which dependencies are actively used within exported functions  
- Builds structured dependency relationships between functions and external modules  

---

#### 🧪 Mock Requirement Planning  

- Analyzes dependency usage to determine which external modules require mocking  
- Groups dependency interactions based on function-level usage  
- Produces structured mock planning data  

---

#### 🧩 Jest Mock Code Preparation  

- Converts mock planning data into Jest-compatible mock code fragments  
- Generates reusable mock definitions based on detected dependencies  
- Prepares mock structures that can support future automated test generation  

---

#### 📌 Current Development Scope  

The implemented module focuses on **input analysis, dependency detection and mock preparation**. 

## 🔄 In Progress   

### **7. Chapter 5 – Software Development**  

### 🔹Phase II – Final Report Generation Module  

This module is currently under development and focuses on generating structured reports from the results of executed unit tests. The aim is to provide a clear and organized overview of test outcomes, while laying the groundwork for future analytical enhancements.  

**Current Focus and Features in Progress:**  
- Parsing Jest execution results to extract pass/fail counts  
- Preparing preliminary summaries for total tests, passed, and failed  
- Formatting error messages for easier review   
- Generating a descriptive JSON report  
- Establishing the foundation for future enhancements such as detailed metrics, failure categorization, and developer-friendly visual summaries  

---  

# ✍️ Closing Note  

This repository is the official and complete record of our **Final Year Project**, documenting every phase from research to implementation.  
Its structure ensures clarity, traceability, and academic professionalism while supporting continuous development throughout the FYP timeline.  

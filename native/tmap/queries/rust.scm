(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(union_item name: (type_identifier) @name) @definition.union
(type_item name: (type_identifier) @name) @definition.type
(trait_item name: (type_identifier) @name) @definition.trait
(impl_item type: (_) @name) @definition.impl
(declaration_list (function_item name: (identifier) @name) @definition.method)
(declaration_list (function_signature_item name: (identifier) @name) @definition.method)
(function_item name: (identifier) @name) @definition.function
(mod_item name: (identifier) @name) @definition.module
(macro_definition name: (identifier) @name) @definition.macro
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.static
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(call_expression function: (scoped_identifier name: (identifier) @name)) @reference.call
(macro_invocation macro: (identifier) @name) @reference.macro

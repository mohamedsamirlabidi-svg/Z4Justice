def adapt(payload: dict) -> dict:
    """
    Acrobate Solution-specific enrichments and field mapping.
    
    Ensures all extracted data is properly formatted for backend ingestion.
    """
    payload.setdefault('currency', 'TND')
    
    # Ensure metadata includes all available fields
    metadata = payload.get('metadata', {})
    
    # Map command/order number
    if 'commandeNo' not in metadata and payload.get('paymentTerms'):
        metadata['commandeNo'] = payload['paymentTerms']
    
    # Ensure payment method is documented if extracted
    if 'paymentMethod' not in metadata:
        metadata['paymentMethod'] = None
    
    # Add extraction confidence to metadata
    if 'aiConfidence' not in metadata and payload.get('notes'):
        # Try to extract confidence from notes
        import re
        match = re.search(r'confidence:([\d.]+)', payload.get('notes', ''))
        if match:
            metadata['aiConfidence'] = float(match.group(1))
    
    payload['metadata'] = metadata
    
    return payload
